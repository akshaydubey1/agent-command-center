/**
 * Auto Router
 * -----------
 * Deterministic, dependency-free request classification and model selection.
 *
 * Design rules:
 *  - Pure functions only. No network, no globals beyond an injectable env bag,
 *    so the whole file is unit-testable under `node --test`.
 *  - Classification is additive scoring, not first-match. A phrase like
 *    "quick reply to my doctor" must not escalate into a full high-stakes run
 *    just because it contains a risk keyword.
 *  - Provider preferences live in data (strengths, tiers, prices, context
 *    windows), never in hardcoded `provider === "claude"` branches, so adding a
 *    provider is a configuration change rather than a code change.
 */

export type AgentId = "inbox" | "builder" | "verifier" | "chief";
export type Provider = "openai" | "gemini" | "claude" | "perplexity";
export type ModelPreference = "auto" | Provider;
export type CostTier = "free" | "low" | "standard" | "premium";
export type TaskClass =
  | "quick_text"
  | "email"
  | "coding"
  | "research"
  | "long_context"
  | "high_stakes"
  | "analysis"
  | "general";

export type Strength =
  | "quick"
  | "writing"
  | "coding"
  | "research"
  | "longContext"
  | "reasoning";

export type EnvBag = Record<string, string | undefined>;

export type ModelProfile = {
  provider: Provider;
  model: string | null;
  costTier: CostTier;
  inputCostPerMillion: number | null;
  outputCostPerMillion: number | null;
  /** Usable context window in tokens. Used to exclude models that cannot fit the request. */
  contextWindow: number;
  available: boolean;
  strengths: Record<Strength, number>;
};

export type SignalKey =
  | "quick"
  | "email"
  | "coding"
  | "implementation"
  | "fresh"
  | "longDoc"
  | "risk"
  | "irreversible"
  | "analysis";

export type RequestClassification = {
  taskClass: TaskClass;
  complexity: 1 | 2 | 3 | 4 | 5;
  estimatedInputTokens: number;
  needsFreshInformation: boolean;
  needsEmailContext: boolean;
  /** True when the request names an action that cannot be undone (send, deploy, delete, charge). */
  irreversible: boolean;
  rationale: string;
  /** Matched signal keys with their accumulated weights, for UI transparency. */
  signals: Partial<Record<SignalKey, number>>;
  /** Score for every candidate class, so a routing decision can be explained or debugged. */
  scores: Record<TaskClass, number>;
};

export type RoutingDecision = {
  agent: AgentId;
  provider: Provider;
  model: string | null;
  costTier: CostTier;
  requested: ModelPreference;
  estimatedInputTokens: number;
  maxOutputTokens: number;
  reason: string;
  /** Ordered fallback providers, best first. */
  alternatives: Provider[];
  /** Projected spend for this single call in USD, when prices are configured. */
  projectedCostUsd: number | null;
  score: number;
};

export type RoutingPlan = {
  classification: RequestClassification;
  activeAgents: AgentId[];
  skippedAgents: AgentId[];
  estimatedTotalTokens: number;
  projectedCostUsd: number | null;
  strategy: "free-first" | "balanced" | "quality-first";
  decisions: RoutingDecision[];
};

export const allProviders: Provider[] = [
  "openai",
  "gemini",
  "claude",
  "perplexity",
];

export const allAgents: AgentId[] = ["inbox", "builder", "verifier", "chief"];

export const providerNames: Record<Provider, string> = {
  openai: "OpenAI",
  gemini: "Gemini",
  claude: "Claude",
  perplexity: "Perplexity",
};

const costWeight: Record<CostTier, number> = {
  free: 0,
  low: 1,
  standard: 2.5,
  premium: 5,
};

const defaultStrengths: Record<Provider, Record<Strength, number>> = {
  openai: { quick: 8, writing: 8, coding: 9, research: 7, longContext: 8, reasoning: 10 },
  gemini: { quick: 10, writing: 8, coding: 8, research: 8, longContext: 10, reasoning: 8 },
  claude: { quick: 7, writing: 10, coding: 10, research: 7, longContext: 9, reasoning: 9 },
  perplexity: { quick: 6, writing: 7, coding: 7, research: 10, longContext: 7, reasoning: 8 },
};

const defaultContextWindow: Record<Provider, number> = {
  openai: 200_000,
  gemini: 1_000_000,
  claude: 200_000,
  perplexity: 128_000,
};

const defaultTier: Record<Provider, CostTier> = {
  openai: "standard",
  gemini: "free",
  claude: "standard",
  perplexity: "standard",
};

/* -------------------------------------------------------------------------- */
/* Catalog                                                                     */
/* -------------------------------------------------------------------------- */

function parseTier(value: string | undefined, fallback: CostTier): CostTier {
  const normalized = value?.trim().toLowerCase();
  return normalized === "free" ||
    normalized === "low" ||
    normalized === "standard" ||
    normalized === "premium"
    ? normalized
    : fallback;
}

function parseOptionalNumber(value: string | undefined) {
  if (!value?.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function parsePositiveInt(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

/**
 * Parses `MODEL_<PROVIDER>_STRENGTHS="coding:9,reasoning:7"`.
 * Unlisted strengths keep the built-in default, values are clamped to 0..10.
 */
function parseStrengths(
  value: string | undefined,
  fallback: Record<Strength, number>,
): Record<Strength, number> {
  if (!value?.trim()) return { ...fallback };
  const next = { ...fallback };
  for (const entry of value.split(",")) {
    const [rawKey, rawScore] = entry.split(":");
    const key = rawKey?.trim() as Strength | undefined;
    const score = Number(rawScore);
    if (!key || !(key in next) || !Number.isFinite(score)) continue;
    next[key] = Math.min(10, Math.max(0, score));
  }
  return next;
}

function readEnv(env: EnvBag | undefined): EnvBag {
  if (env) return env;
  // `process` is absent in some Worker contexts; fall back to an empty bag.
  return typeof process !== "undefined" && process.env ? process.env : {};
}

export function getModelCatalog(env?: EnvBag): ModelProfile[] {
  const bag = readEnv(env);
  return allProviders.map((provider) => {
    const key = provider.toUpperCase();
    const model = bag[`MODEL_${key}`]?.trim() || null;
    return {
      provider,
      model,
      costTier: parseTier(bag[`MODEL_${key}_TIER`], defaultTier[provider]),
      inputCostPerMillion: parseOptionalNumber(bag[`MODEL_${key}_INPUT_COST_PER_M`]),
      outputCostPerMillion: parseOptionalNumber(bag[`MODEL_${key}_OUTPUT_COST_PER_M`]),
      contextWindow: parsePositiveInt(
        bag[`MODEL_${key}_CONTEXT`],
        defaultContextWindow[provider],
      ),
      available: Boolean(model) && bag[`MODEL_${key}_ENABLED`] !== "false",
      strengths: parseStrengths(
        bag[`MODEL_${key}_STRENGTHS`],
        defaultStrengths[provider],
      ),
    };
  });
}

export function profileFor(provider: Provider, catalog = getModelCatalog()) {
  return catalog.find((profile) => profile.provider === provider) ?? null;
}

/* -------------------------------------------------------------------------- */
/* Classification                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Blends character and word counts. Pure character division badly
 * underestimates code and badly overestimates prose with long words.
 */
export function estimateTokens(text: string) {
  const trimmed = text.trim();
  if (!trimmed) return 1;
  const byChars = trimmed.length / 4;
  const byWords = trimmed.split(/\s+/).length * 1.35;
  return Math.max(1, Math.ceil((byChars + byWords) / 2));
}

type SignalPattern = { key: SignalKey; weight: number; re: RegExp };

const signalPatterns: SignalPattern[] = [
  // Short text transformations.
  { key: "quick", weight: 2, re: /\b(rephrase|reword|rewrite|proofread|fix (the )?grammar|grammar|spellcheck|shorten|tighten|polish|caption|subject line|tl;?dr|make (this|it) (clearer|clear|professional|friendly|shorter))\b/ },
  // Email and inbox work.
  { key: "email", weight: 2, re: /\b(e?mails?|inbox|repl(y|ies)|respond|gmail|outlook|message threads?|threads?|follow[- ]?ups?|cc|bcc|unread|newsletter)\b/ },
  // Engineering surface area.
  { key: "coding", weight: 1.5, re: /\b(code|coding|debug|bug|stack ?trace|exception|tests?|typescript|javascript|python|java|golang|rust|sql|regexp?|api|endpoint|kubernetes|k8s|terraform|helm|jenkins|docker|ci\/cd|pipeline|repository|repo|migration|schema|yaml|linter?|scripts?|functions?|helpers?|modules?|classes?|sdk|cli|compiler?|runtime)\b/ },
  {
    key: "implementation",
    weight: 2,
    re: /\b(build|implement|refactor|rewrite the code|automate|integrate|deploy|fix (the )?(bug|code|error|test)|(write|add|create|make)\b[^.]{0,30}\b(app|api|service|script|function|helper|module|class|component|hook|endpoint|test|job|worker|migration|dashboard|feature|field)s?)\b/,
  },
  // Freshness / research.
  { key: "fresh", weight: 2, re: /\b(latest|current|currently|today|this (week|month|year)|news|prices?|pricing|availability|recent|research|sources?|cite|citation|compare (products?|vendors?|tools?)|market|benchmark|job (opening|posting)|who is|what happened|release notes?)\b/ },
  // Large inputs.
  { key: "longDoc", weight: 2.5, re: /\b(long document|large (file|document)|entire (repo|repository|codebase)|whole (repo|repository|codebase)|many files|full transcript|all (of my )?e?mails|attached (document|file|report)|book|manuscript)\b/ },
  // Consequential subject matter.
  { key: "risk", weight: 2, re: /\b(immigration|visa|legal|lawyer|attorney|contract|litigation|medical|health|diagnos\w*|prescription|finance|financial|tax(es)?|payroll|invoice|security incident|breach|vulnerability|cve|outage|incident|credentials?|secrets?|compliance|hipaa|gdpr|soc ?2|pci|nda)\b/ },
  // Irreversible external effects.
  {
    key: "irreversible",
    weight: 3,
    re: /\b(send (the |this |that )?(e?mail|message|reply|invite)|delete|drop (the )?(table|database|index)|deploy\w*[^.]{0,40}\b(prod\w*|live|customers?)|deploy to prod\w*|production deploy|push to prod\w*|purchase|buy|charge (the )?(card|customer)|wire|refund|terminate|revoke|rotate (the )?(key|secret|credential)|force[- ]push|merge to (main|master)|publish|go live)\b/,
  },
  // Thinking work.
  { key: "analysis", weight: 1.8, re: /\b(analy[sz]e|analysis|architecture|strategy|roadmap|plan|evaluate|root cause|trade[- ]?offs?|design|decision|compare|pros and cons|recommend|assess|review|business model|monetiz\w*|revenue|go[- ]to[- ]market)\b/ },
];

function collectSignals(text: string) {
  const signals: Partial<Record<SignalKey, number>> = {};
  for (const pattern of signalPatterns) {
    const matches = text.match(new RegExp(pattern.re.source, "g"));
    if (!matches) continue;
    // Repeat mentions add evidence, but with diminishing returns.
    const hits = Math.min(matches.length, 3);
    signals[pattern.key] =
      (signals[pattern.key] ?? 0) + pattern.weight * (1 + (hits - 1) * 0.35);
  }
  return signals;
}

const emptyScores: Record<TaskClass, number> = {
  quick_text: 0,
  email: 0,
  coding: 0,
  research: 0,
  long_context: 0,
  high_stakes: 0,
  analysis: 0,
  general: 0,
};

const baseComplexity: Record<TaskClass, 1 | 2 | 3 | 4 | 5> = {
  quick_text: 1,
  email: 2,
  general: 2,
  research: 3,
  analysis: 3,
  coding: 4,
  long_context: 4,
  high_stakes: 5,
};

const rationales: Record<TaskClass, string> = {
  quick_text:
    "Short text transformation: one low-cost model is enough, so extra agent calls are skipped.",
  email:
    "Email task: use an efficient writing model and activate Inbox Agent only when needed.",
  coding:
    "Engineering request: coding strength plus an independent verification pass are required.",
  research:
    "Current-information request: research capability and source grounding are prioritized.",
  long_context:
    "Large context request: context handling and reasoning quality outweigh the cheapest route.",
  high_stakes:
    "High-stakes request: quality and independent verification take priority over lowest cost.",
  analysis:
    "Analytical request: balance reasoning quality, review coverage, and token cost.",
  general:
    "General request: choose the least expensive configured model that clears the quality threshold.",
};

export function classifyRequest(prompt: string): RequestClassification {
  const text = prompt.toLowerCase();
  const estimatedInputTokens = estimateTokens(prompt);
  const signal = collectSignals(text);
  const s = (key: SignalKey) => signal[key] ?? 0;

  const irreversible = s("irreversible") > 0;
  /**
   * A short rewrite or a quick reply stays a short rewrite even when the
   * subject matter happens to mention a doctor or a contract. Risk only
   * escalates the class when the request also asks for judgement, code, or an
   * action with external consequences.
   */
  const transformational =
    !irreversible &&
    estimatedInputTokens <= 400 &&
    s("implementation") === 0 &&
    (s("quick") > 0 || (s("email") > 0 && s("analysis") === 0));

  const scores: Record<TaskClass, number> = { ...emptyScores };

  scores.quick_text =
    s("quick") * 4 -
    s("implementation") * 3 -
    s("coding") * 2 -
    s("risk") * 2 -
    s("longDoc") * 4 -
    s("fresh") * 2 -
    (estimatedInputTokens > 350 ? 6 : 0) -
    (irreversible ? 6 : 0);

  scores.email = s("email") * 3 + s("quick") * 0.5 - s("implementation") * 1.5;

  scores.coding = s("coding") * 2 + s("implementation") * 2.2 - s("fresh") * 0.5;

  scores.research = s("fresh") * 3 - s("implementation");

  scores.long_context =
    s("longDoc") * 4 +
    (estimatedInputTokens > 2500 ? 6 : estimatedInputTokens > 1200 ? 2 : 0);

  scores.high_stakes =
    (s("risk") * 3 + s("irreversible") * 2) * (transformational ? 0.45 : 1);

  scores.analysis = s("analysis") * 2.2 + (estimatedInputTokens > 600 ? 1 : 0);

  // Floor: anything that clears nothing else is general work.
  scores.general = 1.5;

  let taskClass: TaskClass = "general";
  let best = scores.general;
  // Deterministic ordering: higher score wins, ties break toward the cheaper class.
  const order: TaskClass[] = [
    "quick_text",
    "email",
    "general",
    "research",
    "analysis",
    "coding",
    "long_context",
    "high_stakes",
  ];
  for (const candidate of order) {
    if (scores[candidate] > best) {
      best = scores[candidate];
      taskClass = candidate;
    }
  }

  const families = (Object.keys(signal) as SignalKey[]).length;
  let complexity = baseComplexity[taskClass] as number;
  if (estimatedInputTokens > 1500) complexity += 1;
  if (families >= 4) complexity += 1;
  if (taskClass !== "high_stakes" && irreversible) complexity += 1;
  complexity = Math.min(5, Math.max(1, complexity));

  return {
    taskClass,
    complexity: complexity as 1 | 2 | 3 | 4 | 5,
    estimatedInputTokens,
    needsFreshInformation: s("fresh") > 0 && taskClass !== "quick_text",
    needsEmailContext: s("email") > 0,
    irreversible,
    rationale: irreversible
      ? `${rationales[taskClass]} An irreversible action was detected, so review and approval are mandatory.`
      : rationales[taskClass],
    signals: signal,
    scores,
  };
}

/* -------------------------------------------------------------------------- */
/* Agent activation and budgets                                                */
/* -------------------------------------------------------------------------- */

export function activeAgentsFor(
  classification: RequestClassification,
  includeInbox: boolean,
): AgentId[] {
  const wantsInbox = includeInbox && classification.needsEmailContext;
  const withInbox = (agents: AgentId[]): AgentId[] =>
    wantsInbox ? ["inbox", ...agents.filter((a) => a !== "inbox")] : agents;

  // An irreversible request always gets supervision and an independent review,
  // whatever else the classifier decided.
  if (classification.irreversible) {
    return withInbox(["chief", "builder", "verifier"]);
  }

  switch (classification.taskClass) {
    case "quick_text":
      return ["builder"];
    case "email":
      return wantsInbox ? ["inbox", "builder"] : ["builder"];
    case "general":
      return ["builder"];
    case "research":
      return withInbox(["builder", "verifier"]);
    case "analysis":
      return withInbox(["chief", "builder", "verifier"]);
    case "coding":
    case "long_context":
    case "high_stakes":
      return withInbox(["chief", "builder", "verifier"]);
  }
}

export function maxOutputFor(agent: AgentId, taskClass: TaskClass) {
  if (agent === "inbox") return taskClass === "email" ? 550 : 350;
  if (agent === "verifier") return taskClass === "quick_text" ? 200 : 750;
  if (agent === "chief") return taskClass === "coding" ? 900 : 750;
  const byTask: Record<TaskClass, number> = {
    quick_text: 260,
    email: 650,
    coding: 1800,
    research: 1300,
    long_context: 1800,
    high_stakes: 1400,
    analysis: 1100,
    general: 750,
  };
  return byTask[taskClass];
}

export function focusFor(agent: AgentId, taskClass: TaskClass): Strength {
  if (agent === "inbox") return "writing";
  if (agent === "verifier") return taskClass === "research" ? "research" : "reasoning";
  if (agent === "chief") return "reasoning";
  if (taskClass === "quick_text") return "quick";
  if (taskClass === "email") return "writing";
  if (taskClass === "coding") return "coding";
  if (taskClass === "research") return "research";
  if (taskClass === "long_context") return "longContext";
  return "reasoning";
}

/* -------------------------------------------------------------------------- */
/* Cost                                                                        */
/* -------------------------------------------------------------------------- */

export function projectCost(
  profile: Pick<ModelProfile, "inputCostPerMillion" | "outputCostPerMillion">,
  inputTokens: number,
  outputTokens: number,
): number | null {
  if (
    profile.inputCostPerMillion === null ||
    profile.outputCostPerMillion === null
  ) {
    return null;
  }
  return (
    (inputTokens / 1_000_000) * profile.inputCostPerMillion +
    (outputTokens / 1_000_000) * profile.outputCostPerMillion
  );
}

/* -------------------------------------------------------------------------- */
/* Selection                                                                   */
/* -------------------------------------------------------------------------- */

export function scoreProfile(
  profile: ModelProfile,
  agent: AgentId,
  classification: RequestClassification,
  preferFree: boolean,
) {
  const focus = focusFor(agent, classification.taskClass);
  const quality = profile.strengths[focus];
  const complexity = classification.complexity;
  const qualityWeight = 1.2 + complexity * 0.45;
  const savingsWeight = 3.2 - Math.min(complexity, 4) * 0.45;
  let score = quality * qualityWeight - costWeight[profile.costTier] * savingsWeight;

  if (preferFree && profile.costTier === "free") {
    score += complexity <= 2 ? 8 : 1.5;
  }
  // Freshness is a capability, so it is read from the strength table rather
  // than from a hardcoded provider name.
  if (classification.needsFreshInformation) {
    score += (profile.strengths.research - 7) * 1.6;
  }
  if (classification.taskClass === "long_context") {
    score += (profile.strengths.longContext - 7) * 1.4;
    // Reward genuine headroom over the estimated input.
    const headroom = profile.contextWindow / Math.max(classification.estimatedInputTokens, 1);
    score += Math.min(4, Math.log10(Math.max(headroom, 1)) * 2);
  }
  if (classification.taskClass === "high_stakes" || classification.irreversible) {
    score += (profile.strengths.reasoning - 7) * 1.5;
  }
  if (classification.taskClass === "quick_text" && profile.costTier !== "free") {
    score -= 4;
  }

  const projected = projectCost(
    profile,
    classification.estimatedInputTokens,
    maxOutputFor(agent, classification.taskClass),
  );
  if (projected !== null) {
    score -= projected * (complexity <= 2 ? 50 : 15);
  }
  return score;
}

function reasonFor(
  profile: ModelProfile,
  classification: RequestClassification,
  requested: ModelPreference,
  manualUnavailable: boolean,
) {
  const name = providerNames[profile.provider];
  if (manualUnavailable) {
    return `The manual provider was unavailable, so Auto Router selected ${name} as the best configured fallback.`;
  }
  if (requested !== "auto") {
    return `Manual override: ${name} will handle this agent's work.`;
  }
  switch (classification.taskClass) {
    case "quick_text":
      return `Short rewrite: ${name} offers the lowest-cost capable route; extra agents are skipped.`;
    case "research":
      return `Fresh research: ${name} best matches source-aware retrieval and verification needs.`;
    case "coding":
      return `Engineering work: ${name} scored highest for this agent's coding or reasoning role.`;
    case "long_context":
      return `Long context: ${name} was favored for context handling and reasoning headroom.`;
    case "high_stakes":
      return `High-stakes request: ${name} was selected for quality and review reliability.`;
    default:
      return profile.costTier === "free"
        ? `Free-first route: ${name} clears the quality threshold without paid-token usage.`
        : `Balanced route: ${name} provides the best quality-to-cost score for this role.`;
  }
}

function selectForAgent(
  agent: AgentId,
  classification: RequestClassification,
  preference: ModelPreference,
  catalog: ModelProfile[],
  liveOnly: boolean,
  preferFree: boolean,
): RoutingDecision {
  const maxOutputTokens = maxOutputFor(agent, classification.taskClass);
  const base = liveOnly ? catalog.filter((profile) => profile.available) : catalog;
  if (base.length === 0) {
    throw new Error("No model is configured for automatic routing");
  }

  // Prefer models that can actually hold the request; fall back to all of them
  // rather than failing outright when nothing fits.
  const needed = classification.estimatedInputTokens + maxOutputTokens;
  const fitting = base.filter((profile) => profile.contextWindow >= needed);
  const eligible = fitting.length > 0 ? fitting : base;

  const manual =
    preference === "auto"
      ? null
      : (eligible.find((profile) => profile.provider === preference) ?? null);
  const manualUnavailable = preference !== "auto" && !manual;

  const scored = eligible
    .map((profile) => ({
      profile,
      score: scoreProfile(profile, agent, classification, preferFree),
    }))
    .sort((a, b) =>
      b.score === a.score
        ? a.profile.provider.localeCompare(b.profile.provider)
        : b.score - a.score,
    );

  const selected = manual ?? scored[0].profile;
  const selectedScore =
    scored.find((entry) => entry.profile.provider === selected.provider)?.score ?? 0;

  return {
    agent,
    provider: selected.provider,
    model: selected.model,
    costTier: selected.costTier,
    requested: preference,
    estimatedInputTokens: classification.estimatedInputTokens,
    maxOutputTokens,
    reason: reasonFor(selected, classification, preference, manualUnavailable),
    alternatives: scored
      .filter((entry) => entry.profile.provider !== selected.provider)
      .map((entry) => entry.profile.provider),
    projectedCostUsd: projectCost(
      selected,
      classification.estimatedInputTokens,
      maxOutputTokens,
    ),
    score: Number(selectedScore.toFixed(3)),
  };
}

export function buildRoutingPlan(options: {
  prompt: string;
  includeInbox: boolean;
  preferences: Partial<Record<AgentId, ModelPreference>>;
  liveOnly: boolean;
  allowedProviders?: Provider[];
  catalog?: ModelProfile[];
  env?: EnvBag;
}): RoutingPlan {
  const classification = classifyRequest(options.prompt);
  const activeAgents = activeAgentsFor(classification, options.includeInbox);
  const skippedAgents = allAgents.filter((agent) => !activeAgents.includes(agent));

  const catalog = (options.catalog ?? getModelCatalog(options.env)).filter(
    (profile) =>
      !options.allowedProviders ||
      options.allowedProviders.includes(profile.provider),
  );
  if (catalog.length === 0) {
    throw new Error("Enable at least one model provider for Auto Router");
  }

  const preferFree = readEnv(options.env).ROUTER_PREFER_FREE !== "false";
  const decisions = activeAgents.map((agent) =>
    selectForAgent(
      agent,
      classification,
      options.preferences[agent] ?? "auto",
      catalog,
      options.liveOnly,
      preferFree,
    ),
  );

  const estimatedTotalTokens = decisions.reduce(
    (total, decision) =>
      total + decision.estimatedInputTokens + decision.maxOutputTokens,
    0,
  );
  const priced = decisions.filter((decision) => decision.projectedCostUsd !== null);
  const projectedCostUsd =
    priced.length === decisions.length && decisions.length > 0
      ? priced.reduce((total, decision) => total + (decision.projectedCostUsd ?? 0), 0)
      : null;

  return {
    classification,
    activeAgents,
    skippedAgents,
    estimatedTotalTokens,
    projectedCostUsd,
    strategy:
      classification.complexity <= 2
        ? "free-first"
        : classification.complexity >= 4
          ? "quality-first"
          : "balanced",
    decisions,
  };
}
