import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  type GatewayConfig,
  GatewayError,
  backoffDelay,
  callModel,
  parseRetryAfter,
  readGatewayConfig,
} from "../lib/gateway.ts";
import {
  type ModelProfile,
  type RoutingDecision,
  getModelCatalog,
} from "../lib/model-router.ts";

const config: GatewayConfig = {
  url: "https://gateway.test/v1",
  apiKey: "secret",
  timeoutMs: 1000,
  maxAttempts: 2,
  baseBackoffMs: 10,
  maxBackoffMs: 40,
};

const catalog: ModelProfile[] = getModelCatalog({
  MODEL_OPENAI: "openai/gpt-x",
  MODEL_GEMINI: "gemini/flash",
  MODEL_CLAUDE: "anthropic/sonnet",
  MODEL_PERPLEXITY: "perplexity/sonar",
  MODEL_OPENAI_INPUT_COST_PER_M: "1",
  MODEL_OPENAI_OUTPUT_COST_PER_M: "2",
});

const decision: RoutingDecision = {
  agent: "builder",
  provider: "openai",
  model: "openai/gpt-x",
  costTier: "standard",
  requested: "auto",
  estimatedInputTokens: 100,
  maxOutputTokens: 500,
  reason: "test",
  alternatives: ["gemini", "claude"],
  projectedCostUsd: null,
  score: 1,
};

function reply(content: string, usage?: Record<string, number>) {
  return new Response(
    JSON.stringify({ choices: [{ message: { content } }], usage }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

const noSleep = async () => {};

function run(fetchImpl: typeof fetch, overrides: Partial<Parameters<typeof callModel>[0]> = {}) {
  return callModel({
    decision,
    agent: "builder",
    messages: [{ role: "user", content: "hi" }],
    config,
    catalog,
    fetchImpl,
    sleepImpl: noSleep,
    ...overrides,
  });
}

describe("readGatewayConfig", () => {
  it("returns null until both the url and key are set", () => {
    assert.equal(readGatewayConfig({ LLM_GATEWAY_URL: "https://x/v1" }), null);
    assert.equal(readGatewayConfig({ LLM_GATEWAY_API_KEY: "k" }), null);
  });

  it("trims a trailing slash and applies defaults", () => {
    const parsed = readGatewayConfig({
      LLM_GATEWAY_URL: "https://x/v1/",
      LLM_GATEWAY_API_KEY: "k",
    })!;
    assert.equal(parsed.url, "https://x/v1");
    assert.ok(parsed.timeoutMs > 0);
    assert.ok(parsed.maxAttempts >= 1);
  });
});

describe("parseRetryAfter", () => {
  it("reads seconds", () => {
    assert.equal(parseRetryAfter("2"), 2000);
  });

  it("reads an HTTP date", () => {
    const now = Date.now();
    const header = new Date(now + 3000).toUTCString();
    const parsed = parseRetryAfter(header, now)!;
    assert.ok(parsed >= 2000 && parsed <= 3000);
  });

  it("caps absurd values and ignores junk", () => {
    assert.equal(parseRetryAfter("99999"), 30_000);
    assert.equal(parseRetryAfter("soon"), null);
    assert.equal(parseRetryAfter(null), null);
  });
});

describe("backoffDelay", () => {
  it("grows exponentially and stays under the cap", () => {
    const first = backoffDelay(1, config, () => 1);
    const second = backoffDelay(2, config, () => 1);
    assert.ok(second > first);
    assert.ok(backoffDelay(9, config, () => 1) <= config.maxBackoffMs);
  });
});

describe("callModel", () => {
  it("returns content, usage, and computed cost", async () => {
    const result = await run(async () =>
      reply("done", { prompt_tokens: 120, completion_tokens: 60 }),
    );
    assert.equal(result.content, "done");
    assert.equal(result.usage.inputTokens, 120);
    assert.equal(result.usage.estimated, false);
    // 120/1e6 * 1 + 60/1e6 * 2
    assert.ok(Math.abs((result.costUsd ?? 0) - 0.00024) < 1e-9);
    assert.equal(result.fallbackFrom, null);
  });

  it("estimates usage when the provider omits it", async () => {
    const result = await run(async () => reply("four"));
    assert.equal(result.usage.estimated, true);
    assert.ok(result.usage.outputTokens >= 1);
  });

  it("retries a 429 on the same provider and then succeeds", async () => {
    let calls = 0;
    const result = await run(async () => {
      calls += 1;
      return calls === 1
        ? new Response("busy", { status: 429, headers: { "Retry-After": "1" } })
        : reply("recovered");
    });
    assert.equal(calls, 2);
    assert.equal(result.provider, "openai");
    assert.equal(result.attempts.filter((a) => !a.ok).length, 1);
    assert.equal(result.attempts[0].retryInMs, 1000);
  });

  it("moves to the next provider after exhausting retries", async () => {
    const seen: string[] = [];
    const result = await run(async (_url, init) => {
      const model = JSON.parse(String(init?.body ?? "{}")).model as string;
      seen.push(model);
      return seen.length <= 2 ? new Response("boom", { status: 503 }) : reply("second provider");
    });
    assert.equal(result.provider, "gemini");
    assert.equal(result.fallbackFrom, "openai");
    assert.deepEqual(seen.slice(0, 2), ["openai/gpt-x", "openai/gpt-x"]);
  });

  it("does not waste retries on a non-retryable status", async () => {
    let openaiCalls = 0;
    const result = await run(async (_url, init) => {
      const model = JSON.parse(String(init?.body ?? "{}")).model;
      if (model === "openai/gpt-x") {
        openaiCalls += 1;
        return new Response("bad key", { status: 401 });
      }
      return reply("fallback");
    });
    assert.equal(openaiCalls, 1);
    assert.equal(result.provider, "gemini");
  });

  it("skips providers that are not configured", async () => {
    const partial = catalog.map((profile) =>
      profile.provider === "openai" ? { ...profile, available: false } : profile,
    );
    const result = await run(async () => reply("gemini answered"), { catalog: partial });
    assert.equal(result.provider, "gemini");
  });

  it("respects the allowed provider list", async () => {
    const result = await run(async () => reply("only claude"), {
      allowedProviders: ["claude"],
    });
    assert.equal(result.provider, "claude");
  });

  it("throws a GatewayError when every route fails", async () => {
    await assert.rejects(
      () => run(async () => new Response("down", { status: 500 })),
      (error: unknown) => {
        assert.ok(error instanceof GatewayError);
        assert.match(error.message, /All model routes failed/);
        assert.ok(error.attempts.length >= 4);
        return true;
      },
    );
  });

  it("treats an empty completion as a failed route", async () => {
    let calls = 0;
    const result = await run(async () => {
      calls += 1;
      return calls === 1 ? reply("") : reply("real answer");
    });
    assert.equal(result.provider, "gemini");
  });

  it("stops immediately when the caller aborts", async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      () => run(async () => reply("never"), { signal: controller.signal }),
      /Run cancelled/,
    );
  });

  it("reports a timeout as a retryable failure", async () => {
    let calls = 0;
    const result = await run(
      async (_url, init) => {
        calls += 1;
        if (calls === 1) {
          const error = new Error("The operation was aborted");
          error.name = "AbortError";
          // Simulate the fetch rejecting because the timeout controller fired.
          (init?.signal as AbortSignal | undefined)?.throwIfAborted?.();
          throw error;
        }
        return reply("after timeout");
      },
      { config: { ...config, maxAttempts: 2 } },
    );
    assert.equal(calls, 2);
    assert.equal(result.content, "after timeout");
  });
});
