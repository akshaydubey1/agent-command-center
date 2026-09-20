/**
 * POST /api/runs/:runId/approvals/:approvalId
 * Records an approve or reject decision as a durable audit entry. The workspace
 * deliberately does not execute the external action: a decision here is the
 * owner's authorisation record, not an automatic send, deploy, or charge.
 */

import { NextResponse } from "next/server";

import { tryGetDb } from "@/db";
import { appEnv } from "@/lib/env";
import { authorize } from "@/lib/identity";
import { decideApproval } from "@/lib/run-store";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ runId: string; approvalId: string }> },
) {
  const env = appEnv();
  const access = authorize(request.headers, env);
  if (!access.allowed) {
    return NextResponse.json({ error: access.error }, { status: access.status });
  }

  let body: { state?: string };
  try {
    body = (await request.json()) as { state?: string };
  } catch {
    return NextResponse.json({ error: "Invalid decision." }, { status: 400 });
  }

  if (body.state !== "approved" && body.state !== "rejected") {
    return NextResponse.json(
      { error: "Decision must be `approved` or `rejected`." },
      { status: 400 },
    );
  }

  if (!access.identity.persistable) {
    return NextResponse.json({
      recorded: false,
      durable: false,
      reason: "Sign in to record approval decisions beyond this browser.",
    });
  }

  const { runId, approvalId } = await context.params;
  const result = await decideApproval(
    tryGetDb(),
    access.identity,
    runId,
    approvalId,
    body.state,
  );

  if (!result.ok) {
    // No database is a degraded mode, not a failure: the browser keeps the
    // decision locally and the UI says so.
    const status = result.reason === "Run not found." ? 404 : 200;
    return NextResponse.json(
      { recorded: false, durable: false, reason: result.reason },
      { status },
    );
  }

  return NextResponse.json({ recorded: true, durable: true, state: body.state });
}
