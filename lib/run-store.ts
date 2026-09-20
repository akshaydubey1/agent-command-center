/**
 * Run store
 * ---------
 * Persists missions, per-agent steps, and approval decisions in Cloudflare D1.
 * Every function takes the database explicitly and every caller treats a null
 * database as "history is browser-local this deployment" rather than an error.
 */

import { and, desc, eq, gte, sql } from "drizzle-orm";

import type { AppDatabase } from "@/db";
import { agentSteps, approvals, runs } from "@/db/schema";
import type { Identity } from "@/lib/identity";
import type {
  AgentResult,
  ApprovalItem,
  RunTotals,
  WorkflowSummary,
} from "@/lib/orchestrator";
import type { RoutingDecision } from "@/lib/model-router";

export type PersistRunInput = {
  runId: string;
  createdAt: string;
  prompt: string;
  mode: string;
  connected: boolean;
  status: "complete" | "failed" | "cancelled";
  summary: string;
  finalDeliverable: string;
  agents: AgentResult[];
  approvals: ApprovalItem[];
  routing: RoutingDecision[];
  totals: RunTotals;
  workflow: WorkflowSummary;
  error?: string | null;
};

export type StoredRunSummary = {
  runId: string;
  createdAt: string;
  summary: string;
  status: string;
  connected: boolean;
  taskClass: string;
  costUsd: number | null;
  totalTokens: number;
  pendingApprovals: number;
};

function isMissingTable(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : "";
  return /no such table/i.test(`${message} ${cause}`);
}

export const MIGRATION_HINT =
  "Run history tables are missing. Generate SQL with `npm run db:generate`, then apply the migration to D1 before history is stored.";

export async function persistRun(
  db: AppDatabase | null,
  identity: Identity,
  input: PersistRunInput,
): Promise<{ stored: boolean; reason?: string }> {
  if (!db) return { stored: false, reason: "No D1 binding is configured." };

  if (!identity.persistable) {
    return { stored: false, reason: "Anonymous runs are not stored." };
  }

  try {
    const inserted = await db
      .insert(runs)
      .values({
        id: input.runId,
        ownerId: identity.userId,
        ownerEmail: identity.email,
        prompt: input.prompt,
        summary: input.summary,
        finalDeliverable: input.finalDeliverable,
        mode: input.mode,
        status: input.status,
        connected: input.connected,
        taskClass: input.workflow.taskClass,
        complexity: input.workflow.complexity,
        strategy: input.workflow.strategy,
        activeAgents: JSON.stringify(input.workflow.activeAgents),
        estimatedTokens: input.workflow.estimatedTotalTokens,
        inputTokens: input.totals.inputTokens,
        outputTokens: input.totals.outputTokens,
        costUsd: input.totals.costUsd,
        modelCalls: input.totals.modelCalls,
        revisions: input.totals.revisions,
        error: input.error ?? null,
        createdAt: input.createdAt,
        completedAt: new Date().toISOString(),
      })
      .onConflictDoNothing()
      .returning({ id: runs.id });

    // A run already on file keeps its steps and approvals; re-inserting them
    // would duplicate every row.
    if (inserted.length === 0) return { stored: true };

    const steps = input.agents
      .filter((agent) => agent.status !== "idle")
      .map((agent) => ({
        runId: input.runId,
        agent: agent.id,
        revision: agent.revisions,
        provider: agent.provider,
        model: agent.model,
        status: agent.status,
        output: agent.output,
        inputTokens: agent.usage?.inputTokens ?? 0,
        outputTokens: agent.usage?.outputTokens ?? 0,
        costUsd: agent.costUsd,
        latencyMs: agent.latencyMs,
        createdAt: input.createdAt,
      }));
    if (steps.length > 0) await db.insert(agentSteps).values(steps);

    if (input.approvals.length > 0) {
      await db
        .insert(approvals)
        .values(
          input.approvals.map((item) => ({
            id: item.id,
            runId: input.runId,
            title: item.title,
            detail: item.detail,
            risk: item.risk,
            state: item.state,
            createdAt: input.createdAt,
          })),
        )
        .onConflictDoNothing();
    }

    return { stored: true };
  } catch (error) {
    return {
      stored: false,
      reason: isMissingTable(error)
        ? MIGRATION_HINT
        : error instanceof Error
          ? error.message
          : "Run history could not be saved.",
    };
  }
}

export async function listRuns(
  db: AppDatabase | null,
  ownerId: string,
  limit = 12,
): Promise<{ runs: StoredRunSummary[]; reason?: string }> {
  if (!db) return { runs: [], reason: "No D1 binding is configured." };
  try {
    const rows = await db
      .select()
      .from(runs)
      .where(eq(runs.ownerId, ownerId))
      .orderBy(desc(runs.createdAt))
      .limit(Math.min(Math.max(limit, 1), 50));

    const pending = await db
      .select({ runId: approvals.runId, count: sql<number>`count(*)` })
      .from(approvals)
      .where(eq(approvals.state, "pending"))
      .groupBy(approvals.runId);
    const pendingByRun = new Map(pending.map((row) => [row.runId, Number(row.count)]));

    return {
      runs: rows.map((row) => ({
        runId: row.id,
        createdAt: row.createdAt,
        summary: row.summary,
        status: row.status,
        connected: row.connected,
        taskClass: row.taskClass,
        costUsd: row.costUsd,
        totalTokens: row.inputTokens + row.outputTokens,
        pendingApprovals: pendingByRun.get(row.id) ?? 0,
      })),
    };
  } catch (error) {
    return {
      runs: [],
      reason: isMissingTable(error)
        ? MIGRATION_HINT
        : error instanceof Error
          ? error.message
          : "Run history could not be read.",
    };
  }
}

export async function loadRun(
  db: AppDatabase | null,
  ownerId: string,
  runId: string,
) {
  if (!db) return null;
  try {
    const [row] = await db
      .select()
      .from(runs)
      .where(and(eq(runs.id, runId), eq(runs.ownerId, ownerId)))
      .limit(1);
    if (!row) return null;

    const steps = await db.select().from(agentSteps).where(eq(agentSteps.runId, runId));
    const queue = await db.select().from(approvals).where(eq(approvals.runId, runId));

    return { run: row, steps, approvals: queue };
  } catch {
    return null;
  }
}

/**
 * Records a decision. The workspace never executes the external action itself;
 * the decision is an audit record the owner can act on.
 */
export async function decideApproval(
  db: AppDatabase | null,
  identity: Identity,
  runId: string,
  approvalId: string,
  state: "approved" | "rejected",
): Promise<{ ok: boolean; reason?: string }> {
  if (!db) return { ok: false, reason: "No D1 binding is configured." };
  try {
    const [owned] = await db
      .select({ id: runs.id })
      .from(runs)
      .where(and(eq(runs.id, runId), eq(runs.ownerId, identity.userId)))
      .limit(1);
    if (!owned) return { ok: false, reason: "Run not found." };

    await db
      .update(approvals)
      .set({
        state,
        decidedBy: identity.email ?? identity.userId,
        decidedAt: new Date().toISOString(),
      })
      .where(and(eq(approvals.id, approvalId), eq(approvals.runId, runId)));
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : "The decision could not be saved.",
    };
  }
}

/** Durable daily counter backing the rate limiter's second layer. */
export async function countRunsToday(db: AppDatabase | null, ownerId: string) {
  if (!db) return 0;
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const [row] = await db
      .select({ count: sql<number>`count(*)` })
      .from(runs)
      .where(and(eq(runs.ownerId, ownerId), gte(runs.createdAt, since)));
    return Number(row?.count ?? 0);
  } catch {
    return 0;
  }
}
