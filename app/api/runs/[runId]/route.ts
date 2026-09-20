/**
 * GET /api/runs/:runId
 * Rehydrates one stored mission, including per-agent steps and the current
 * approval queue. Scoped to the requesting owner.
 */

import { NextResponse } from "next/server";

import { tryGetDb } from "@/db";
import { appEnv } from "@/lib/env";
import { authorize } from "@/lib/identity";
import { loadRun } from "@/lib/run-store";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ runId: string }> },
) {
  const env = appEnv();
  const access = authorize(request.headers, env);
  if (!access.allowed) {
    return NextResponse.json({ error: access.error }, { status: access.status });
  }

  if (!access.identity.persistable) {
    return NextResponse.json({ error: "Run not found." }, { status: 404 });
  }

  const { runId } = await context.params;
  const record = await loadRun(tryGetDb(), access.identity.userId, runId);
  if (!record) {
    return NextResponse.json({ error: "Run not found." }, { status: 404 });
  }

  return NextResponse.json({
    runId: record.run.id,
    createdAt: record.run.createdAt,
    summary: record.run.summary,
    finalDeliverable: record.run.finalDeliverable,
    connected: record.run.connected,
    status: record.run.status,
    mode: record.run.mode,
    workflow: {
      taskClass: record.run.taskClass,
      complexity: record.run.complexity,
      strategy: record.run.strategy,
      activeAgents: JSON.parse(record.run.activeAgents || "[]") as string[],
      estimatedTotalTokens: record.run.estimatedTokens,
    },
    totals: {
      inputTokens: record.run.inputTokens,
      outputTokens: record.run.outputTokens,
      costUsd: record.run.costUsd,
      modelCalls: record.run.modelCalls,
      revisions: record.run.revisions,
    },
    agents: record.steps,
    approvals: record.approvals,
  });
}
