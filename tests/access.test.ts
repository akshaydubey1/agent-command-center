import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { authorize, identityFrom } from "../lib/identity.ts";
import { consume, readDailyCap, readRateLimitRule } from "../lib/rate-limit.ts";

function headers(values: Record<string, string>) {
  return new Headers(values);
}

describe("identityFrom", () => {
  it("reads the platform user id and email", () => {
    const identity = identityFrom(
      headers({
        "oai-authenticated-user-id": "user_123",
        "oai-authenticated-user-email": "owner@example.com",
      }),
    );
    assert.equal(identity.userId, "user_123");
    assert.equal(identity.anonymous, false);
  });

  it("decodes a percent-encoded full name only when the encoding header says so", () => {
    const encoded = identityFrom(
      headers({
        "oai-authenticated-user-id": "user_123",
        "oai-authenticated-user-full-name": "Ada%20Lovelace",
        "oai-authenticated-user-full-name-encoding": "percent-encoded-utf-8",
      }),
    );
    assert.equal(encoded.fullName, "Ada Lovelace");

    const raw = identityFrom(
      headers({
        "oai-authenticated-user-id": "user_123",
        "oai-authenticated-user-full-name": "Ada Lovelace",
      }),
    );
    assert.equal(raw.fullName, "Ada Lovelace");
  });

  it("falls back to an anonymous identity", () => {
    const identity = identityFrom(headers({}));
    assert.equal(identity.anonymous, true);
    assert.equal(identity.userId, "anonymous");
  });

  it("accepts a service token as a non-anonymous caller", () => {
    const identity = identityFrom(headers({ "x-mission-token": "abc" }), {
      MISSION_API_TOKEN: "abc",
    });
    assert.equal(identity.anonymous, false);
    assert.equal(identity.viaToken, true);
  });

  it("rejects a wrong token", () => {
    const identity = identityFrom(headers({ "x-mission-token": "nope" }), {
      MISSION_API_TOKEN: "abc",
    });
    assert.equal(identity.anonymous, true);
  });
});

describe("authorize", () => {
  it("allows anonymous visitors by default", () => {
    assert.equal(authorize(headers({})).allowed, true);
  });

  it("refuses anonymous visitors when sign-in is required", () => {
    const decision = authorize(headers({}), { REQUIRE_SIGNED_IN: "true" });
    assert.equal(decision.allowed, false);
    assert.equal(decision.allowed === false && decision.status, 401);
  });

  it("allows a signed-in visitor when sign-in is required", () => {
    const decision = authorize(headers({ "oai-authenticated-user-id": "user_1" }), {
      REQUIRE_SIGNED_IN: "true",
    });
    assert.equal(decision.allowed, true);
  });
});

describe("rate limiting", () => {
  const rule = { limit: 3, windowMs: 60_000 };

  it("allows up to the limit and then blocks", () => {
    const store = new Map<string, number[]>();
    const now = 1_000_000;
    for (let index = 0; index < 3; index += 1) {
      assert.equal(consume("owner", rule, now, store).allowed, true);
    }
    const blocked = consume("owner", rule, now, store);
    assert.equal(blocked.allowed, false);
    assert.ok(blocked.retryAfterSeconds > 0);
  });

  it("frees capacity once the window slides", () => {
    const store = new Map<string, number[]>();
    const now = 1_000_000;
    for (let index = 0; index < 3; index += 1) consume("owner", rule, now, store);
    assert.equal(consume("owner", rule, now + 60_001, store).allowed, true);
  });

  it("keeps identities independent", () => {
    const store = new Map<string, number[]>();
    const now = 1_000_000;
    for (let index = 0; index < 3; index += 1) consume("a", rule, now, store);
    assert.equal(consume("b", rule, now, store).allowed, true);
  });

  it("treats a zero limit as disabled", () => {
    const store = new Map<string, number[]>();
    assert.equal(consume("owner", { limit: 0, windowMs: 1000 }, 1, store).allowed, true);
  });

  it("reads limits from the environment with sane defaults", () => {
    assert.equal(readRateLimitRule({ RATE_LIMIT_RUNS_PER_MINUTE: "10" }).limit, 10);
    assert.equal(readRateLimitRule({}).limit, 6);
    assert.equal(readDailyCap({ RATE_LIMIT_RUNS_PER_DAY: "5" }), 5);
    assert.equal(readDailyCap({ RATE_LIMIT_RUNS_PER_DAY: "junk" }), 120);
  });
});
