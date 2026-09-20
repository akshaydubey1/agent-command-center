/**
 * Mission orchestrator
 * --------------------
 * Runs the four-agent workflow as an async event stream so the browser can
 * watch progress instead of staring at a spinner for the length of four
 * sequential model calls.
 *
 * What it adds over a plain request/response handler:
 *  - typed lifecycle events (`agent.started`, `agent.retry`, `agent.completed`)
 *    that the SSE route forwards verbatim,
 *  - the Verifier -> Builder revision loop the architecture promises: when the
 *    Verifier returns `VERDICT: REVISE`, Builder gets the corrections and the
 *    work is re-checked,
 *  - real token and cost totals accumulated from provider usage,
 *  - cooperative cancellation through an `AbortSignal`,
 *  - a preview mode that emits the *same* event sequence when no gateway is
 *    configured, so the UI has a single code path.
 */

import {
  type AgentId,
  type EnvBag,
  type ModelPreference,
  type ModelProfile,
  type Provider,
  type RoutingDecision,
  type RoutingPlan,
  allAgents,
  buildRoutingPlan,
  getModelCatalog,
  providerNames,
} from "./model-router.ts";
import {
  type ChatMessage,
  type GatewayAttempt,
  type GatewayConfig,
  type Usage,
  GatewayError,
  callModel,
  readGatewayConfig,
} from "./gateway.ts";

/** Shown in the interface and given to the agents as who they work for. */
export const DEFAULT_OWNER_NAME = "the owner";

/** Deployments set OWNER_NAME; nothing personal is baked into the code. */
export function ownerName(env?: EnvBag) {
  const configured = env?.OWNER_NAME?.trim();
  if (configured) return configured;
  const fromProcess =
    typeof process !== "undefined" ? process.env?.OWNER_NAME?.trim() : undefined;
  return fromProcess || DEFAULT_OWNER_NAME;
}

export type ApprovalMode = "prepare" | "guarded" | "autonomous";
export type RunStatus = "idle" | "working" | "complete" | "blocked" | "failed";

export type ApprovalItem = {
  id: string;
  title: string;
  detail: string;
  risk: "low" | "medium" | "high";
  state: "pending" | "approved" | "rejected";
};

export type AgentResult = {
  id: AgentId;
  status: RunStatus;
  output: string;
  checks: string[];
  provider: Provider | null;
  model: string | null;
  usage: Usage | null;
  costUsd: number | null;
  latencyMs: number | null;
  revisions: number;
};

export type RunTotals = {
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  latencyMs: number;
  modelCalls: number;
  revisions: number;
};

export type RunEvent =
  | {
      type: "run.started";
      runId: string;
      createdAt: string;
      owner: string;
      connected: boolean;
      mode: ApprovalMode;
      plan: RoutingPlan;
    }
  | {
      type: "agent.started";
      agent: AgentId;
      provider: Provider;
      model: string | null;
      maxOutputTokens: number;
      reason: string;
      revision: number;
      step: number;
      totalSteps: number;
    }
  | {
      type: "agent.retry";
      agent: AgentId;
      attempt: GatewayAttempt;
    }
  | {
      type: "agent.completed";
      agent: AgentId;
      provider: Provider;
      model: string | null;
      content: string;
      usage: Usage | null;
      costUsd: number | null;
      latencyMs: number | null;
      revision: number;
      fallbackFrom: Provider | null;
      step: number;
      totalSteps: number;
    }
  | { type: "agent.skipped"; agent: AgentId; reason: string }
  | { type: "agent.failed"; agent: AgentId; error: string }
  | { type: "revision.requested"; round: number; corrections: string }
  | {
      type: "run.completed";
      runId: string;
      connected: boolean;
      summary: string;
      finalDeliverable: string;
      agents: AgentResult[];
      approvals: ApprovalItem[];
      routing: RoutingDecision[];
      totals: RunTotals;
      workflow: WorkflowSummary;
      createdAt: string;
    }
  | { type: "run.failed"; runId: string; error: string; cancelled: boolean };

export type WorkflowSummary = {
  taskClass: string;
  complexity: number;
  rationale: string;
  activeAgents: AgentId[];
  skippedAgents: AgentId[];
  estimatedTotalTokens: number;
  strategy: RoutingPlan["strategy"];
  signals: string[];
  irreversible: boolean;
};

export type MissionOptions = {
  prompt: string;
  mode: ApprovalMode;
  includeInbox: boolean;
  preferences: Partial<Record<AgentId, ModelPreference>>;
  enabledProviders: Provider[];
  gatewayEnabled: boolean;
  env?: EnvBag;
  catalog?: ModelProfile[];
  gatewayConfig?: GatewayConfig | null;
  signal?: AbortSignal;
  runId?: string;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  newId?: () => string;
  maxRevisions?: number;
};

function systemPromptFor(agent: AgentId, owner: string): string {
  const prompts: Record<AgentId, string> = {
    inbox: `You are the Inbox Agent working for ${owner}. Identify requests, deadlines, commitments, missing information, and suggested replies. You have read-only intent: never claim an email was sent, deleted, or moved. Prepare actions for approval.`,
    builder: `You are the Builder Agent working for ${owner}. Produce the strongest concrete solution you can. For code, include the implementation and how to validate it. For writing, deliver a polished draft. State assumptions plainly and mark anything you could not verify.`,
    verifier: `You are the Verifier Agent working for ${owner}. Review the proposed work adversarially: correctness, completeness, security, testing, and whether the requested outcome is actually met. Begin your reply with exactly "VERDICT: PASS" or "VERDICT: REVISE" on its own line, then list precise, numbered corrections. Do not rewrite the work yourself.`,
    chief: `You are the Chief Agent supervising specialists for ${owner}. Own completion, delegate clearly, reconcile disagreements, and return a concise, approval-ready package. Never authorize external actions yourself.`,
  };
  return prompts[agent];
}

const agentNames: Record<AgentId, string> = {
  inbox: "Inbox Agent",
  builder: "Builder Agent",
  verifier: "Verifier Agent",
  chief: "Chief Agent",
};

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

export function conciseMission(prompt: string, limit = 96) {
  const line = prompt.replace(/\s+/g, " ").trim();
  return line.length > limit ? `${line.slice(0, limit - 3)}...` : line;
}

/** Splits the Verifier's structured verdict from its corrections. */
export function parseVerdict(output: string): {
  verdict: "pass" | "revise";
  corrections: string;
} {
  const match = output.match(/^\s*VERDICT:\s*(PASS|REVISE)\b/i);
  const verdict = match?.[1]?.toLowerCase() === "revise" ? "revise" : "pass";
  const corrections = output.replace(/^\s*VERDICT:\s*(PASS|REVISE)\b[^\n]*\n?/i, "").trim();
  return { verdict, corrections: corrections || output.trim() };
}

const irreversibleRules: Array<{ re: RegExp; title: string; detail: string }> = [
  {
    re: /\b(send|reply to|forward)\b[^.]*\b(e?mail|message|invite)\b|\b(e?mail|message)\s+(him|her|them|the team|the client)\b/i,
    title: "Send prepared email",
    detail: "A message leaves the workspace only after you approve the exact recipient and body.",
  },
  {
    re: /\b(deploy|release|ship|push to prod\w*|go live|publish)\b/i,
    title: "Deploy or publish",
    detail: "Deployment and publication change a live system. Approve only after reviewing the plan and rollback.",
  },
  {
    re: /\b(delete|drop (the )?(table|database|index)|terminate|revoke|force[- ]push)\b/i,
    title: "Destructive change",
    detail: "This action cannot be undone. Confirm the exact target and that a backup exists.",
  },
  {
    re: /\b(purchase|buy|charge|wire|refund|subscribe)\b/i,
    title: "Spend or refund money",
    detail: "A financial action needs your explicit approval with the amount and recipient confirmed.",
  },
  {
    re: /\b(rotate (the )?(key|secret|credential)|change (the )?password|revoke (the )?token)\b/i,
    title: "Credential change",
    detail: "Credential changes can lock out services. Approve with a recovery path ready.",
  },
];

export function deriveApprovals(
  prompt: string,
  plan: RoutingPlan,
  newId: () => string,
): ApprovalItem[] {
  const items: ApprovalItem[] = [];
  if (plan.classification.irreversible) {
    for (const rule of irreversibleRules) {
      if (!rule.re.test(prompt)) continue;
      items.push({
        id: newId(),
        title: rule.title,
        detail: rule.detail,
        risk: "high",
        state: "pending",
      });
    }
  }
  items.push({
    id: newId(),
    title: "Release prepared result",
    detail:
      "Review the final package before sending, committing, publishing, purchasing, or changing an external system.",
    risk: plan.classification.irreversible ? "high" : "medium",
    state: "pending",
  });
  // De-duplicate by title, keeping the first occurrence.
  return items.filter(
    (item, index) => items.findIndex((other) => other.title === item.title) === index,
  );
}

function workflowSummary(plan: RoutingPlan): WorkflowSummary {
  return {
    taskClass: plan.classification.taskClass,
    complexity: plan.classification.complexity,
    rationale: plan.classification.rationale,
    activeAgents: plan.activeAgents,
    skippedAgents: plan.skippedAgents,
    estimatedTotalTokens: plan.estimatedTotalTokens,
    strategy: plan.strategy,
    signals: Object.keys(plan.classification.signals),
    irreversible: plan.classification.irreversible,
  };
}

function emptyResult(agent: AgentId, reason: string): AgentResult {
  return {
    id: agent,
    status: "idle",
    output: reason,
    checks: ["No model call made", "Tokens preserved"],
    provider: null,
    model: null,
    usage: null,
    costUsd: null,
    latencyMs: null,
    revisions: 0,
  };
}

/* -------------------------------------------------------------------------- */
/* Preview mode                                                                */
/* -------------------------------------------------------------------------- */

function previewOutput(agent: AgentId, prompt: string, plan: RoutingPlan) {
  const mission = conciseMission(prompt);
  if (agent === "chief") {
    return `Chief prepared the handoff for "${mission}": confirm the outcome, have Builder shape the smallest complete solution, then have Verifier challenge correctness, risk, and completion criteria before the final package.`;
  }
  if (agent === "builder") {
    return `Builder drafted a first pass for "${mission}": clarify the target, define the smallest useful workflow, name the assumptions, and sequence the work so the first deliverable is testable.`;
  }
  if (agent === "verifier") {
    return "VERDICT: PASS\nVerifier checklist prepared: confirm the stated outcome is actually met, check edge cases and failure paths, confirm no external action was taken, and confirm cost per task stays inside budget.";
  }
  return plan.classification.needsEmailContext
    ? "Inbox context was requested. This preview cannot read or send email until an email bridge is configured, so no message content is claimed."
    : "Inbox Agent was not required for this request, so no inbox model call was made.";
}

function previewDeliverable(prompt: string, plan: RoutingPlan, mode: ApprovalMode) {
  return [
    plan.classification.rationale,
    `Active agents: ${plan.activeAgents.map((a) => agentNames[a]).join(", ")}.`,
    plan.skippedAgents.length
      ? `Skipped to save tokens: ${plan.skippedAgents.map((a) => agentNames[a]).join(", ")}.`
      : "All agents are required for this request.",
    `Estimated working budget: about ${plan.estimatedTotalTokens.toLocaleString()} tokens.`,
    plan.projectedCostUsd !== null
      ? `Projected spend at configured prices: $${plan.projectedCostUsd.toFixed(4)}.`
      : "Add per-million token prices to project spend for this route.",
    "",
    ...plan.decisions.map(
      (decision) =>
        `${agentNames[decision.agent]}: ${providerNames[decision.provider]} (${decision.costTier}) - ${decision.reason}`,
    ),
    "",
    mode === "prepare"
      ? "Internal planning is complete for this preview. Approval is needed only before an external action."
      : "Only actions allowed by the selected approval policy may proceed.",
    "Connect the model gateway to replace this deterministic preview with live provider responses.",
  ].join("\n");
}

/* -------------------------------------------------------------------------- */
/* Run                                                                         */
/* -------------------------------------------------------------------------- */


/**
 * An unbounded async queue. The pipeline pushes events the moment they happen
 * and the generator hands them to the caller as they arrive.
 *
 * This is what makes a retry visible while the call is still retrying: the
 * earlier implementation buffered events and flushed them only between agent
 * calls, so `agent.retry` reached the browser after the call it described had
 * already finished.
 */
function createEventQueue<T>() {
  const items: T[] = [];
  let wake: (() => void) | null = null;
  let closed = false;

  return {
    push(item: T) {
      if (closed) return;
      items.push(item);
      const resume = wake;
      wake = null;
      resume?.();
    },
    close() {
      closed = true;
      const resume = wake;
      wake = null;
      resume?.();
    },
    async *drain(): AsyncGenerator<T, void, void> {
      for (;;) {
        while (items.length > 0) yield items.shift()!;
        if (closed) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
  };
}

export async function* runMission(
  options: MissionOptions,
): AsyncGenerator<RunEvent, void, void> {
  const now = options.now ?? Date.now;
  const newId =
    options.newId ??
    (() =>
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : `id-${Math.random().toString(36).slice(2)}`);
  const runId = options.runId ?? newId();
  const createdAt = new Date(now()).toISOString();
  const catalog = options.catalog ?? getModelCatalog(options.env);
  const gatewayConfig =
    options.gatewayConfig !== undefined
      ? options.gatewayConfig
      : readGatewayConfig(options.env);

  const connected = Boolean(
    options.gatewayEnabled &&
      gatewayConfig &&
      catalog.some(
        (profile) =>
          profile.available && options.enabledProviders.includes(profile.provider),
      ),
  );

  const queue = createEventQueue<RunEvent>();

  const pipeline = (async () => {
    let plan: RoutingPlan;
    try {
      plan = buildRoutingPlan({
        prompt: options.prompt,
        includeInbox: options.includeInbox,
        preferences: options.preferences,
        liveOnly: connected,
        allowedProviders: options.enabledProviders,
        catalog,
        env: options.env,
      });
    } catch (error) {
      queue.push({
        type: "run.failed",
        runId,
        cancelled: false,
        error:
          error instanceof Error
            ? `Auto Router stopped safely: ${error.message}`
            : "Auto Router stopped safely.",
      });
      return;
    }

    queue.push({
      type: "run.started",
      runId,
      createdAt,
      owner: ownerName(options.env),
      connected,
      mode: options.mode,
      plan,
    });

    const results = new Map<AgentId, AgentResult>();
    const totals: RunTotals = {
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      latencyMs: 0,
      modelCalls: 0,
      revisions: 0,
    };
    let costKnown = true;

    const configuredRevisions = Number(options.env?.ORCHESTRATOR_MAX_REVISIONS);
    const maxRevisions = Math.max(
      0,
      options.maxRevisions ??
        (Number.isFinite(configuredRevisions) ? configuredRevisions : 1),
    );
    const totalSteps =
      plan.activeAgents.length +
      (plan.activeAgents.includes("chief") && connected ? 1 : 0) +
      (plan.activeAgents.includes("verifier") ? maxRevisions * 2 : 0);
    let step = 0;

    const skipReason =
      "Skipped by Auto Router because this request does not need this agent.";
    for (const agent of plan.skippedAgents) {
      queue.push({ type: "agent.skipped", agent, reason: skipReason });
      results.set(agent, emptyResult(agent, skipReason));
    }

    const decisionFor = (agent: AgentId) => {
      const decision = plan.decisions.find((item) => item.agent === agent);
      if (!decision) {
        throw new Error(`${agentNames[agent]} is not active for this request`);
      }
      return decision;
    };

    const record = (
      agent: AgentId,
      output: string,
      revision: number,
      extra: Partial<AgentResult> = {},
    ) => {
      const previous = results.get(agent);
      results.set(agent, {
        id: agent,
        status: "complete",
        output,
        checks: [
          "Assigned by Auto Router",
          revision > 0
            ? `Revised ${revision} time(s) after review`
            : "Completed within token budget",
        ],
        provider: extra.provider ?? previous?.provider ?? null,
        model: extra.model ?? previous?.model ?? null,
        usage: extra.usage ?? previous?.usage ?? null,
        costUsd: extra.costUsd ?? previous?.costUsd ?? null,
        latencyMs: extra.latencyMs ?? previous?.latencyMs ?? null,
        revisions: revision,
      });
    };

    async function invoke(
      agent: AgentId,
      userPrompt: string,
      revision: number,
    ): Promise<string> {
      const decision = decisionFor(agent);
      step += 1;
      queue.push({
        type: "agent.started",
        agent,
        provider: decision.provider,
        model: decision.model,
        maxOutputTokens: decision.maxOutputTokens,
        reason: decision.reason,
        revision,
        step,
        totalSteps,
      });

      if (!connected || !gatewayConfig) {
        const content = previewOutput(agent, options.prompt, plan);
        record(agent, content, revision, {
          provider: decision.provider,
          model: decision.model,
        });
        queue.push({
          type: "agent.completed",
          agent,
          provider: decision.provider,
          model: decision.model,
          content,
          usage: null,
          costUsd: null,
          latencyMs: null,
          revision,
          fallbackFrom: null,
          step,
          totalSteps,
        });
        return content;
      }

      const messages: ChatMessage[] = [
        { role: "system", content: systemPromptFor(agent, ownerName(options.env)) },
        { role: "user", content: userPrompt },
      ];

      const result = await callModel({
        decision,
        agent,
        messages,
        config: gatewayConfig,
        catalog,
        allowedProviders: options.enabledProviders,
        signal: options.signal,
        fetchImpl: options.fetchImpl,
        sleepImpl: options.sleepImpl,
        now,
        // Emitted straight into the stream, so a retry is visible while it happens.
        onAttempt: (attempt) => {
          if (!attempt.ok) queue.push({ type: "agent.retry", agent, attempt });
        },
      });

      totals.inputTokens += result.usage.inputTokens;
      totals.outputTokens += result.usage.outputTokens;
      totals.latencyMs += result.latencyMs;
      totals.modelCalls += 1;
      if (result.costUsd === null) costKnown = false;
      else totals.costUsd = (totals.costUsd ?? 0) + result.costUsd;

      plan.decisions = plan.decisions.map((item) =>
        item.agent === agent
          ? {
              ...item,
              provider: result.provider,
              model: result.model,
              reason:
                result.fallbackFrom === null
                  ? item.reason
                  : `${item.reason} Automatic fallback used ${providerNames[result.provider]} after ${providerNames[result.fallbackFrom]} was unavailable.`,
            }
          : item,
      );

      record(agent, result.content, revision, {
        provider: result.provider,
        model: result.model,
        usage: result.usage,
        costUsd: result.costUsd,
        latencyMs: result.latencyMs,
      });
      queue.push({
        type: "agent.completed",
        agent,
        provider: result.provider,
        model: result.model,
        content: result.content,
        usage: result.usage,
        costUsd: result.costUsd,
        latencyMs: result.latencyMs,
        revision,
        fallbackFrom: result.fallbackFrom,
        step,
        totalSteps,
      });
      return result.content;
    }

    try {
      const hasChief = plan.activeAgents.includes("chief");
      const hasVerifier = plan.activeAgents.includes("verifier");
      const hasInbox = plan.activeAgents.includes("inbox");

      const chiefPlan = hasChief
        ? await invoke(
            "chief",
            `Create a concise execution plan for this mission. Approval mode: ${options.mode}. Router assessment: ${plan.classification.rationale}\nMission:\n${options.prompt}`,
            0,
          )
        : `Auto Router selected a minimal ${plan.strategy} workflow for this ${plan.classification.taskClass} request.`;

      const inboxOutput = hasInbox
        ? await invoke(
            "inbox",
            `Prepare the email intake work needed for this mission. Do not claim any message was sent.\nMission: ${options.prompt}\nPlan: ${chiefPlan}`,
            0,
          )
        : "Inbox Agent was not needed for this request.";

      let builderOutput = await invoke(
        "builder",
        `Complete the requested work. Keep the output concise for a simple task and thorough only when complexity requires it.\nMission: ${options.prompt}\nPlan: ${chiefPlan}\nInbox context: ${inboxOutput}`,
        0,
      );

      let verifierOutput = hasVerifier
        ? await invoke(
            "verifier",
            `Review this work.\nMission: ${options.prompt}\nProposed work:\n${builderOutput}`,
            0,
          )
        : "Verifier was skipped because the request is low risk and simple.";

      let round = 0;
      while (hasVerifier && round < maxRevisions) {
        const { verdict, corrections } = parseVerdict(verifierOutput);
        if (verdict === "pass") break;
        round += 1;
        totals.revisions += 1;
        queue.push({ type: "revision.requested", round, corrections });

        builderOutput = await invoke(
          "builder",
          `Your previous work was reviewed and needs revision. Apply every correction, then return the complete revised work (not a diff).\nMission: ${options.prompt}\nPrevious work:\n${builderOutput}\nCorrections:\n${corrections}`,
          round,
        );

        verifierOutput = await invoke(
          "verifier",
          `Re-review the revised work. Confirm every correction was applied.\nMission: ${options.prompt}\nRevised work:\n${builderOutput}`,
          round,
        );
      }

      const finalDeliverable = connected
        ? hasChief
          ? await invoke(
              "chief",
              `Prepare the final approval-ready package. Incorporate the verifier's corrections and never claim an external action occurred.\nMission: ${options.prompt}\nBuilder:\n${builderOutput}\nVerifier:\n${verifierOutput}`,
              round,
            )
          : hasVerifier
            ? `${builderOutput}\n\nVerification notes:\n${verifierOutput}`
            : builderOutput
        : previewDeliverable(options.prompt, plan, options.mode);

      for (const agent of plan.activeAgents) {
        if (!results.has(agent)) record(agent, "No output was produced.", 0);
      }

      const agents: AgentResult[] = allAgents.map(
        (agent) => results.get(agent) ?? emptyResult(agent, skipReason),
      );

      queue.push({
        type: "run.completed",
        runId,
        createdAt,
        connected,
        summary: connected
          ? `Auto-routed and completed: ${conciseMission(options.prompt)}`
          : `Prepared Auto Router plan: ${conciseMission(options.prompt)}`,
        finalDeliverable,
        agents,
        approvals: deriveApprovals(options.prompt, plan, newId),
        routing: plan.decisions,
        totals: { ...totals, costUsd: costKnown ? totals.costUsd : null },
        workflow: workflowSummary(plan),
      });
    } catch (error) {
      const cancelled =
        options.signal?.aborted === true ||
        (error instanceof Error && error.message === "Run cancelled");
      const message =
        error instanceof GatewayError
          ? error.message
          : error instanceof Error
            ? error.message
            : String(error);
      queue.push({
        type: "run.failed",
        runId,
        cancelled,
        error: cancelled
          ? "Run cancelled before completion."
          : `Agent run stopped safely: ${message}`,
      });
    }
  })();

  // A rejection here would be a defect in the pipeline itself rather than a
  // provider failure, but it must never surface as an unhandled rejection.
  const settled = pipeline
    .catch((error: unknown) => {
      queue.push({
        type: "run.failed",
        runId,
        cancelled: false,
        error: `Agent run stopped safely: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    })
    .finally(() => queue.close());

  try {
    yield* queue.drain();
  } finally {
    // A caller that stops reading early (client disconnect) must not leave the
    // pipeline running unobserved.
    queue.close();
    await settled;
  }
}

/** Collects the stream into the single JSON payload the non-streaming API returns. */
export async function collectMission(options: MissionOptions) {
  const events: RunEvent[] = [];
  for await (const event of runMission(options)) events.push(event);
  const completed = events.find((event) => event.type === "run.completed");
  const failed = events.find((event) => event.type === "run.failed");
  return { events, completed, failed };
}
