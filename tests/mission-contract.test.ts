import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MAX_BODY_BYTES,
  MAX_PROMPT_LENGTH,
  checkBodySize,
  cleanMode,
  cleanPreference,
  cleanProviders,
  parseMissionBody,
  wantsEventStream,
} from "../lib/mission-contract.ts";
import { identityFrom, rateLimitKey } from "../lib/identity.ts";

function ok(raw: unknown) {
  const result = parseMissionBody(raw);
  assert.equal(result.ok, true, "expected the body to be accepted");
  return result.ok ? result.value : null!;
}

function rejected(raw: unknown) {
  const result = parseMissionBody(raw);
  assert.equal(result.ok, false, "expected the body to be rejected");
  return result.ok ? null! : result;
}

describe("parseMissionBody", () => {
  it("accepts a minimal body and fills safe defaults", () => {
    const value = ok({ prompt: "  Summarize the weekly status.  " });
    assert.equal(value.prompt, "Summarize the weekly status.");
    assert.equal(value.mode, "prepare");
    assert.equal(value.includeInbox, true);
    assert.equal(value.gatewayEnabled, true);
    assert.deepEqual(value.preferences, {
      inbox: "auto", builder: "auto", verifier: "auto", chief: "auto",
    });
    assert.equal(value.enabledProviders.length, 4);
  });

  it("rejects a non-object body", () => {
    assert.equal(rejected("just a string").status, 400);
    assert.equal(rejected(null).status, 400);
    assert.equal(rejected(["prompt"]).status, 400);
  });

  it("rejects a missing, blank, or non-text prompt", () => {
    assert.match(rejected({}).error, /Add a mission/);
    assert.match(rejected({ prompt: "   " }).error, /Add a mission/);
    assert.match(rejected({ prompt: 42 }).error, /must be text/);
  });

  it("rejects an oversized prompt at the boundary", () => {
    assert.equal(parseMissionBody({ prompt: "a".repeat(MAX_PROMPT_LENGTH) }).ok, true);
    const over = rejected({ prompt: "a".repeat(MAX_PROMPT_LENGTH + 1) });
    assert.equal(over.status, 400);
    assert.match(over.error, /characters or fewer/);
  });

  it("never fails on a bad enum — it falls back", () => {
    const value = ok({
      prompt: "hi",
      mode: "yolo",
      models: { builder: "not-a-provider", chief: "claude" },
      enabledProviders: ["openai", "nope", 7],
    });
    assert.equal(value.mode, "prepare");
    assert.equal(value.preferences.builder, "auto");
    assert.equal(value.preferences.chief, "claude");
    assert.deepEqual(value.enabledProviders, ["openai"]);
  });

  it("de-duplicates providers so a chain cannot retry the same route twice", () => {
    const value = ok({ prompt: "hi", enabledProviders: ["claude", "claude", "openai"] });
    assert.deepEqual(value.enabledProviders, ["claude", "openai"]);
  });

  it("falls back to every provider when the list is empty or junk", () => {
    assert.equal(ok({ prompt: "hi", enabledProviders: [] }).enabledProviders.length, 4);
    assert.equal(ok({ prompt: "hi", enabledProviders: "openai" }).enabledProviders.length, 4);
  });

  it("survives a models field that is not an object", () => {
    const value = ok({ prompt: "hi", models: "claude" });
    assert.equal(value.preferences.builder, "auto");
  });

  it("treats explicit false as off for the two boolean switches", () => {
    const value = ok({ prompt: "hi", includeInbox: false, modelGatewayEnabled: false });
    assert.equal(value.includeInbox, false);
    assert.equal(value.gatewayEnabled, false);
  });
});

describe("cleaners", () => {
  it("cleanPreference keeps valid values only", () => {
    assert.equal(cleanPreference("gemini"), "gemini");
    assert.equal(cleanPreference("auto"), "auto");
    assert.equal(cleanPreference("gpt"), "auto");
    assert.equal(cleanPreference(undefined), "auto");
  });

  it("cleanMode keeps the three policies", () => {
    assert.equal(cleanMode("guarded"), "guarded");
    assert.equal(cleanMode("autonomous"), "autonomous");
    assert.equal(cleanMode(""), "prepare");
  });

  it("cleanProviders drops unknown entries", () => {
    assert.deepEqual(cleanProviders(["claude", "bogus"]), ["claude"]);
  });
});

describe("checkBodySize", () => {
  it("passes a normal body", () => {
    assert.equal(checkBodySize(new Headers({ "content-length": "800" })), null);
    assert.equal(checkBodySize(new Headers()), null);
  });

  it("refuses a body larger than the cap", () => {
    const failure = checkBodySize(new Headers({ "content-length": String(MAX_BODY_BYTES + 1) }));
    assert.equal(failure?.status, 413);
  });
});

describe("wantsEventStream", () => {
  it("detects the query flag and the Accept header", () => {
    assert.equal(wantsEventStream("https://x/api/mission?stream=1", new Headers()), true);
    assert.equal(
      wantsEventStream("https://x/api/mission", new Headers({ accept: "text/event-stream" })),
      true,
    );
    assert.equal(
      wantsEventStream("https://x/api/mission", new Headers({ accept: "application/json" })),
      false,
    );
  });

  it("does not throw on a malformed url", () => {
    assert.equal(wantsEventStream("not a url", new Headers()), false);
  });
});

describe("tenancy", () => {
  it("marks a signed-in visitor as able to own stored rows", () => {
    const identity = identityFrom(new Headers({ "oai-authenticated-user-id": "u1" }));
    assert.equal(identity.persistable, true);
  });

  it("never lets anonymous visitors own stored rows", () => {
    // They would otherwise share the single owner id "anonymous" and read
    // each other's runs.
    const identity = identityFrom(new Headers());
    assert.equal(identity.anonymous, true);
    assert.equal(identity.persistable, false);
  });

  it("lets a service token own rows under its own id", () => {
    const identity = identityFrom(new Headers({ "x-mission-token": "t" }), {
      MISSION_API_TOKEN: "t",
    });
    assert.equal(identity.persistable, true);
    assert.equal(identity.userId, "service-token");
  });
});

describe("rateLimitKey", () => {
  it("buckets signed-in callers by account", () => {
    const headers = new Headers({ "oai-authenticated-user-id": "u1" });
    assert.equal(rateLimitKey(headers, identityFrom(headers)), "user:u1");
  });

  it("buckets anonymous callers by address, not by the shared id", () => {
    const a = new Headers({ "cf-connecting-ip": "203.0.113.5" });
    const b = new Headers({ "x-forwarded-for": "198.51.100.9, 10.0.0.1" });
    assert.equal(rateLimitKey(a, identityFrom(a)), "ip:203.0.113.5");
    assert.equal(rateLimitKey(b, identityFrom(b)), "ip:198.51.100.9");
    assert.notEqual(rateLimitKey(a, identityFrom(a)), rateLimitKey(b, identityFrom(b)));
  });

  it("still returns a key when no address header is present", () => {
    const headers = new Headers();
    assert.equal(rateLimitKey(headers, identityFrom(headers)), "ip:unknown");
  });
});
