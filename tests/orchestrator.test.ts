import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { GatewayConfig } from "../lib/gateway.ts";
import { getModelCatalog } from "../lib/model-router.ts";
import {
  type MissionOptions,
  type RunEvent,
  collectMission,
  deriveApprovals,
  parseVerdict,
  runMission,
} from "../lib/orchestrator.ts";
import { buildRoutingPlan } from "../lib/model-router.ts";

const catalog = getModelCatalog({
  MODEL_OPENAI: "openai/gpt-x",
  MODEL_GEMINI: "gemini/flash",
  MODEL_CLAUDE: "anthropic/sonnet",
  MODEL_PERPLEXITY: "perplexity/sonar",
});

const gatewayConfig: GatewayConfig = {
  url: "https://gateway.test/v1",
  apiKey: "secret",
  timeoutMs: 500,
  maxAttempts: 1,
  baseBackoffMs: 1,
  maxBackoffMs: 2,
};

let counter = 0;
const newId = () => `id-${++counter}`;

function baseOptions(overrides: Partial<MissionOptions> = {}): MissionOptions {
  return {
    prompt: "Write and test a retry helper for the deployment script.",
    mode: "prepare",
    includeInbox: false,
    preferences: {},
    enabledProviders: ["openai", "gemini", "claude", "perplexity"],
    gatewayEnabled: false,
    catalog,
    gatewayConfig: null,
    newId,
    sleepImpl: async () => {},
    ...overrides,
  };
}

/** Fake gateway that answers with a scripted reply per agent role. */
function scriptedFetch(script: { verifier: string[]; other?: string }) {
  const verifierReplies = [...script.verifier];
  return async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      messages: Array<{ role: string; content: string }>;
    };
    const system = body.messages[0]?.content ?? "";
    const content = system.includes("Verifier Agent")
      ? (verifierReplies.shift() ?? "VERDICT: PASS\nAll good.")
      : (script.other ?? "work product");
    return new Response(
      JSON.stringify({
        choices: [{ message: { content } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
      { status: 200 },
    );
  };
}

async function collect(options: MissionOptions) {
  const events: RunEvent[] = [];
  for await (const event of runMission(options)) events.push(event);
  return events;
}

describe("parseVerdict", () => {
  it("reads a pass verdict", () => {
    assert.equal(parseVerdict("VERDICT: PASS\nLooks fine").verdict, "pass");
  });

  it("reads a revise verdict and strips the header", () => {
    const parsed = parseVerdict("VERDICT: REVISE\n1. Add a test for the retry path.");
    assert.equal(parsed.verdict, "revise");
    assert.equal(parsed.corrections, "1. Add a test for the retry path.");
  });

  it("defaults to pass when the verifier ignores the format", () => {
    assert.equal(parseVerdict("Seems fine to me.").verdict, "pass");
  });
});

describe("deriveApprovals", () => {
  it("always queues the release decision", () => {
    const plan = buildRoutingPlan({
      prompt: "Summarize this page.",
      includeInbox: false,
      preferences: {},
      liveOnly: false,
      catalog,
    });
    const items = deriveApprovals("Summarize this page.", plan, newId);
    assert.equal(items.length, 1);
    assert.equal(items[0].title, "Release prepared result");
  });

  it("adds a high-risk item that names the irreversible action", () => {
    const prompt = "Send the renewal email to the client and then deploy to production.";
    const plan = buildRoutingPlan({
      prompt,
      includeInbox: true,
      preferences: {},
      liveOnly: false,
      catalog,
    });
    const titles = deriveApprovals(prompt, plan, newId).map((item) => item.title);
    assert.ok(titles.includes("Send prepared email"));
    assert.ok(titles.includes("Deploy or publish"));
    assert.ok(titles.every((title, index) => titles.indexOf(title) === index));
  });
});

describe("runMission in preview mode", () => {
  it("emits the same lifecycle events as a live run", async () => {
    const events = await collect(baseOptions());
    const types = events.map((event) => event.type);
    assert.equal(types[0], "run.started");
    assert.equal(types.at(-1), "run.completed");
    assert.ok(types.includes("agent.started"));
    assert.ok(types.includes("agent.completed"));
  });

  it("reports skipped agents explicitly", async () => {
    const events = await collect(
      baseOptions({ prompt: "Fix the grammar in this sentence." }),
    );
    const skipped = events.filter((event) => event.type === "agent.skipped");
    assert.equal(skipped.length, 3);
  });

  it("marks the run as not connected and charges nothing", async () => {
    const events = await collect(baseOptions());
    const completed = events.find((event) => event.type === "run.completed");
    assert.ok(completed && completed.type === "run.completed");
    assert.equal(completed.connected, false);
    assert.equal(completed.totals.modelCalls, 0);
  });

  it("never claims an email was read or sent", async () => {
    const events = await collect(
      baseOptions({
        prompt: "Check my inbox and draft replies to the unread client emails.",
        includeInbox: true,
      }),
    );
    const completed = events.find((event) => event.type === "run.completed");
    assert.ok(completed && completed.type === "run.completed");
    const inbox = completed.agents.find((agent) => agent.id === "inbox");
    assert.match(inbox!.output, /cannot read or send email/i);
  });
});

describe("runMission against a gateway", () => {
  const liveOptions = (overrides: Partial<MissionOptions> = {}) =>
    baseOptions({
      gatewayEnabled: true,
      gatewayConfig,
      ...overrides,
    });

  it("records usage, cost, and provider per agent", async () => {
    const events = await collect(
      liveOptions({ fetchImpl: scriptedFetch({ verifier: ["VERDICT: PASS\nfine"] }) }),
    );
    const completed = events.find((event) => event.type === "run.completed");
    assert.ok(completed && completed.type === "run.completed");
    assert.equal(completed.connected, true);
    assert.ok(completed.totals.modelCalls >= 3);
    assert.equal(completed.totals.inputTokens, completed.totals.modelCalls * 10);
  });

  it("runs the Verifier to Builder revision loop when corrections are returned", async () => {
    const events = await collect(
      liveOptions({
        fetchImpl: scriptedFetch({
          verifier: ["VERDICT: REVISE\n1. Handle the timeout case.", "VERDICT: PASS\nFixed."],
        }),
      }),
    );
    const revision = events.find((event) => event.type === "revision.requested");
    assert.ok(revision && revision.type === "revision.requested");
    assert.match(revision.corrections, /Handle the timeout case/);

    const builderRuns = events.filter(
      (event) => event.type === "agent.completed" && event.agent === "builder",
    );
    assert.equal(builderRuns.length, 2);

    const completed = events.find((event) => event.type === "run.completed");
    assert.ok(completed && completed.type === "run.completed");
    assert.equal(completed.totals.revisions, 1);
  });

  it("streams a retry while the call is still retrying", async () => {
    // The previous implementation buffered events between agent calls, so a
    // retry reached the browser only after the call it described had finished.
    let release: () => void = () => {};
    const secondAttempt = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      if (calls === 1) return new Response("busy", { status: 429 });
      await secondAttempt;
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "VERDICT: PASS\nfine" } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const iterator = runMission(
      liveOptions({
        prompt: "Summarize the weekly status.",
        maxRevisions: 0,
        gatewayConfig: { ...gatewayConfig, maxAttempts: 2 },
        fetchImpl,
      }),
    )[Symbol.asyncIterator]();

    const seen: string[] = [];
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      seen.push(next.value.type);
      if (next.value.type === "agent.retry") break;
    }

    // The retry event is in hand while the retried call is still outstanding.
    assert.ok(seen.includes("agent.retry"));
    assert.equal(seen.includes("agent.completed"), false);
    assert.equal(calls, 2);

    release();
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      seen.push(next.value.type);
    }
    assert.ok(seen.includes("run.completed"));
  });

  it("stops revising at the configured limit", async () => {
    const events = await collect(
      liveOptions({
        maxRevisions: 0,
        fetchImpl: scriptedFetch({ verifier: ["VERDICT: REVISE\nstill wrong"] }),
      }),
    );
    assert.equal(events.some((event) => event.type === "revision.requested"), false);
  });

  it("surfaces a gateway failure as a safe stop", async () => {
    const events = await collect(
      liveOptions({ fetchImpl: async () => new Response("down", { status: 500 }) }),
    );
    const failed = events.find((event) => event.type === "run.failed");
    assert.ok(failed && failed.type === "run.failed");
    assert.equal(failed.cancelled, false);
    assert.match(failed.error, /stopped safely/);
  });

  it("reports cancellation separately from failure", async () => {
    const controller = new AbortController();
    controller.abort();
    const events = await collect(
      liveOptions({ signal: controller.signal, fetchImpl: scriptedFetch({ verifier: [] }) }),
    );
    const failed = events.find((event) => event.type === "run.failed");
    assert.ok(failed && failed.type === "run.failed");
    assert.equal(failed.cancelled, true);
  });

  it("fails safely when no provider is enabled", async () => {
    const events = await collect(liveOptions({ enabledProviders: [] }));
    const failed = events.find((event) => event.type === "run.failed");
    assert.ok(failed && failed.type === "run.failed");
    assert.match(failed.error, /Auto Router stopped safely/);
  });
});

describe("collectMission", () => {
  it("returns the completed event for the JSON API path", async () => {
    const { completed, failed } = await collectMission(baseOptions());
    assert.ok(completed);
    assert.equal(failed, undefined);
  });
});
