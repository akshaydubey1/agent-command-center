import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  type EnvBag,
  type ModelProfile,
  activeAgentsFor,
  buildRoutingPlan,
  classifyRequest,
  estimateTokens,
  getModelCatalog,
  projectCost,
} from "../lib/model-router.ts";

const env: EnvBag = {
  MODEL_OPENAI: "openai/gpt-x",
  MODEL_GEMINI: "gemini/flash",
  MODEL_CLAUDE: "anthropic/sonnet",
  MODEL_PERPLEXITY: "perplexity/sonar",
  MODEL_GEMINI_TIER: "free",
  MODEL_OPENAI_TIER: "standard",
  MODEL_CLAUDE_TIER: "standard",
  MODEL_PERPLEXITY_TIER: "standard",
};

function plan(prompt: string, overrides: Partial<Parameters<typeof buildRoutingPlan>[0]> = {}) {
  return buildRoutingPlan({
    prompt,
    includeInbox: true,
    preferences: {},
    liveOnly: false,
    env,
    catalog: getModelCatalog(env),
    ...overrides,
  });
}

describe("catalog", () => {
  it("reads models, tiers, prices, and context windows from the environment", () => {
    const catalog = getModelCatalog({
      ...env,
      MODEL_OPENAI_INPUT_COST_PER_M: "2.5",
      MODEL_OPENAI_OUTPUT_COST_PER_M: "10",
      MODEL_OPENAI_CONTEXT: "400000",
    });
    const openai = catalog.find((profile) => profile.provider === "openai")!;
    assert.equal(openai.model, "openai/gpt-x");
    assert.equal(openai.inputCostPerMillion, 2.5);
    assert.equal(openai.contextWindow, 400_000);
    assert.equal(openai.available, true);
  });

  it("treats a provider without a model id as unavailable", () => {
    const catalog = getModelCatalog({ MODEL_GEMINI: "gemini/flash" });
    assert.equal(catalog.find((p) => p.provider === "openai")!.available, false);
    assert.equal(catalog.find((p) => p.provider === "gemini")!.available, true);
  });

  it("honours an explicit disable flag", () => {
    const catalog = getModelCatalog({ ...env, MODEL_CLAUDE_ENABLED: "false" });
    assert.equal(catalog.find((p) => p.provider === "claude")!.available, false);
  });

  it("merges strength overrides and keeps unlisted strengths", () => {
    const catalog = getModelCatalog({ ...env, MODEL_GEMINI_STRENGTHS: "coding:10,bogus:3" });
    const gemini = catalog.find((p) => p.provider === "gemini")!;
    assert.equal(gemini.strengths.coding, 10);
    assert.equal(gemini.strengths.reasoning, 8);
  });
});

describe("estimateTokens", () => {
  it("never returns zero", () => {
    assert.ok(estimateTokens("") >= 1);
  });

  it("grows with input size", () => {
    assert.ok(estimateTokens("a".repeat(4000)) > estimateTokens("short prompt"));
  });
});

describe("classifyRequest", () => {
  it("treats a short rewrite as quick text", () => {
    const result = classifyRequest("Rewrite this sentence so it sounds more professional.");
    assert.equal(result.taskClass, "quick_text");
    assert.equal(result.complexity, 1);
  });

  it("does not escalate a short reply just because the subject is medical", () => {
    // The previous first-match classifier sent this down the five-agent
    // high-stakes path purely because of the word "medical".
    const result = classifyRequest("Draft a quick reply to my medical clinic about rescheduling.");
    assert.equal(result.taskClass, "email");
    assert.ok(result.scores.high_stakes < result.scores.email);
  });

  it("still escalates genuine high-stakes analysis", () => {
    const result = classifyRequest(
      "Analyze this vendor contract for legal risk and tell me which compliance clauses expose us.",
    );
    assert.equal(result.taskClass, "high_stakes");
    assert.equal(result.complexity, 5);
  });

  it("flags irreversible actions", () => {
    const result = classifyRequest("Deploy the payment service to production tonight.");
    assert.equal(result.irreversible, true);
    assert.match(result.rationale, /approval are mandatory/);
  });

  it("classifies engineering work", () => {
    const result = classifyRequest(
      "Debug this TypeScript API endpoint and write unit tests for the failing case.",
    );
    assert.equal(result.taskClass, "coding");
  });

  it("classifies freshness-seeking questions as research", () => {
    const result = classifyRequest("What is the current pricing for managed Kubernetes today?");
    assert.equal(result.taskClass, "research");
    assert.equal(result.needsFreshInformation, true);
  });

  it("classifies very large inputs as long context", () => {
    const result = classifyRequest("summarize this ".repeat(900));
    assert.equal(result.taskClass, "long_context");
  });

  it("falls back to general work", () => {
    const result = classifyRequest("Give me three ideas for a team offsite.");
    assert.equal(result.taskClass, "general");
  });

  it("reports the signals it matched", () => {
    const result = classifyRequest("Debug the deploy pipeline and then send the email.");
    assert.ok(Object.keys(result.signals).includes("irreversible"));
  });
});

describe("activeAgentsFor", () => {
  it("uses Builder alone for a quick rewrite", () => {
    const classification = classifyRequest("Shorten this paragraph.");
    assert.deepEqual(activeAgentsFor(classification, true), ["builder"]);
  });

  it("always supervises and reviews irreversible requests", () => {
    const classification = classifyRequest("Delete the old customer table.");
    const agents = activeAgentsFor(classification, false);
    assert.ok(agents.includes("chief"));
    assert.ok(agents.includes("verifier"));
  });

  it("adds Inbox only when email context is both needed and allowed", () => {
    const classification = classifyRequest(
      "Review the unread emails from the client and write the follow-up plan.",
    );
    assert.ok(activeAgentsFor(classification, true).includes("inbox"));
    assert.ok(!activeAgentsFor(classification, false).includes("inbox"));
  });
});

describe("buildRoutingPlan", () => {
  it("skips agents and records why", () => {
    const result = plan("Fix the grammar in this sentence.");
    assert.deepEqual(result.activeAgents, ["builder"]);
    assert.deepEqual(result.skippedAgents.sort(), ["chief", "inbox", "verifier"]);
    assert.equal(result.strategy, "free-first");
  });

  it("prefers the free tier for simple work", () => {
    const result = plan("Fix the grammar in this sentence.");
    assert.equal(result.decisions[0].costTier, "free");
  });

  it("honours a manual override", () => {
    const result = plan("Fix the grammar in this sentence.", {
      preferences: { builder: "claude" },
    });
    assert.equal(result.decisions[0].provider, "claude");
    assert.match(result.decisions[0].reason, /Manual override/);
  });

  it("falls back and explains when the manual provider is not live", () => {
    const catalog = getModelCatalog({ ...env, MODEL_CLAUDE_ENABLED: "false" });
    const result = plan("Fix the grammar in this sentence.", {
      preferences: { builder: "claude" },
      liveOnly: true,
      catalog,
    });
    assert.notEqual(result.decisions[0].provider, "claude");
    assert.match(result.decisions[0].reason, /manual provider was unavailable/i);
  });

  it("excludes models whose context window cannot hold the request", () => {
    const catalog: ModelProfile[] = getModelCatalog(env).map((profile) =>
      profile.provider === "gemini" ? { ...profile, contextWindow: 1000 } : profile,
    );
    const result = plan("summarize this ".repeat(900), { catalog });
    for (const decision of result.decisions) {
      assert.notEqual(decision.provider, "gemini");
    }
  });

  it("gives every decision an ordered fallback chain", () => {
    const result = plan("Fix the grammar in this sentence.");
    const decision = result.decisions[0];
    assert.equal(decision.alternatives.length, 3);
    assert.ok(!decision.alternatives.includes(decision.provider));
  });

  it("projects spend only when every route is priced", () => {
    const priced = getModelCatalog({
      ...env,
      MODEL_OPENAI_INPUT_COST_PER_M: "1",
      MODEL_OPENAI_OUTPUT_COST_PER_M: "2",
      MODEL_GEMINI_INPUT_COST_PER_M: "0",
      MODEL_GEMINI_OUTPUT_COST_PER_M: "0",
      MODEL_CLAUDE_INPUT_COST_PER_M: "3",
      MODEL_CLAUDE_OUTPUT_COST_PER_M: "15",
      MODEL_PERPLEXITY_INPUT_COST_PER_M: "1",
      MODEL_PERPLEXITY_OUTPUT_COST_PER_M: "1",
    });
    assert.notEqual(plan("Fix the grammar here.", { catalog: priced }).projectedCostUsd, null);
    assert.equal(plan("Fix the grammar here.").projectedCostUsd, null);
  });

  it("throws a clear error when no provider is allowed", () => {
    assert.throws(
      () => plan("anything", { allowedProviders: [] }),
      /at least one model provider/i,
    );
  });
});

describe("projectCost", () => {
  it("computes per-million pricing", () => {
    const cost = projectCost(
      { inputCostPerMillion: 3, outputCostPerMillion: 15 },
      1_000_000,
      1_000_000,
    );
    assert.equal(cost, 18);
  });

  it("returns null when prices are unknown", () => {
    assert.equal(
      projectCost({ inputCostPerMillion: null, outputCostPerMillion: 15 }, 10, 10),
      null,
    );
  });
});
