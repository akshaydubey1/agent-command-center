/**
 * Agent Command Center storage
 * Run history, per-agent steps, and the approval queue live in Cloudflare D1 so
 * they survive a browser refresh, a new device, and a redeploy. The app still
 * works with no D1 binding: the repository degrades to browser-local history.
 */

import { sql } from "drizzle-orm";
import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const runs = sqliteTable(
  "runs",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull().default("local"),
    ownerEmail: text("owner_email"),
    prompt: text("prompt").notNull(),
    summary: text("summary").notNull().default(""),
    finalDeliverable: text("final_deliverable").notNull().default(""),
    mode: text("mode").notNull().default("prepare"),
    /** "running" | "complete" | "failed" | "cancelled" */
    status: text("status").notNull().default("running"),
    connected: integer("connected", { mode: "boolean" }).notNull().default(false),
    taskClass: text("task_class").notNull().default("general"),
    complexity: integer("complexity").notNull().default(2),
    strategy: text("strategy").notNull().default("balanced"),
    /** JSON array of agent ids that actually ran. */
    activeAgents: text("active_agents").notNull().default("[]"),
    estimatedTokens: integer("estimated_tokens").notNull().default(0),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    costUsd: real("cost_usd"),
    modelCalls: integer("model_calls").notNull().default(0),
    revisions: integer("revisions").notNull().default(0),
    error: text("error"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    completedAt: text("completed_at"),
  },
  (table) => [index("runs_owner_created_idx").on(table.ownerId, table.createdAt)],
);

export const agentSteps = sqliteTable(
  "agent_steps",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    runId: text("run_id").notNull(),
    agent: text("agent").notNull(),
    revision: integer("revision").notNull().default(0),
    provider: text("provider"),
    model: text("model"),
    status: text("status").notNull().default("complete"),
    output: text("output").notNull().default(""),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    costUsd: real("cost_usd"),
    latencyMs: integer("latency_ms"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("agent_steps_run_idx").on(table.runId)],
);

export const approvals = sqliteTable(
  "approvals",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull(),
    title: text("title").notNull(),
    detail: text("detail").notNull().default(""),
    /** "low" | "medium" | "high" */
    risk: text("risk").notNull().default("medium"),
    /** "pending" | "approved" | "rejected" */
    state: text("state").notNull().default("pending"),
    decidedBy: text("decided_by"),
    decidedAt: text("decided_at"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("approvals_run_idx").on(table.runId)],
);

export type RunRow = typeof runs.$inferSelect;
export type AgentStepRow = typeof agentSteps.$inferSelect;
export type ApprovalRow = typeof approvals.$inferSelect;
