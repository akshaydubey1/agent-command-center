/**
 * GET /api/runs
 * Durable mission history for the signed-in owner. Returns an empty list with a
 * reason when no D1 binding exists, so the dashboard can fall back to
 * browser-local history without treating it as an error.
 */

import { NextResponse } from "next/server";

import { tryGetDb } from "@/db";
import { appEnv } from "@/lib/env";
import { authorize } from "@/lib/identity";
import { listRuns } from "@/lib/run-store";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const env = appEnv();
  const access = authorize(request.headers, env);
  if (!access.allowed) {
    return NextResponse.json({ error: access.error }, { status: access.status });
  }

  // Anonymous visitors all share one owner id, so they get no shared history:
  // returning rows here would hand one visitor another's runs.
  if (!access.identity.persistable) {
    return NextResponse.json({
      runs: [],
      durable: false,
      reason: "Sign in to keep run history beyond this browser.",
    });
  }

  const limit = Number(new URL(request.url).searchParams.get("limit") ?? 12);
  const result = await listRuns(
    tryGetDb(),
    access.identity.userId,
    Number.isFinite(limit) ? limit : 12,
  );

  return NextResponse.json({
    runs: result.runs,
    durable: !result.reason,
    reason: result.reason ?? null,
  });
}
