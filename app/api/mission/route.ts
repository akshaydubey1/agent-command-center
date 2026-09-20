/**
 * POST /api/mission
 * Two response shapes from one orchestrator:
 *  - `Accept: text/event-stream` (or `?stream=1`) streams lifecycle events so
 *    the dashboard shows each agent as it starts, retries, and finishes.
 *  - Anything else returns a single JSON payload.
 *
 * The route itself only sequences: validate (lib/mission-contract), authorise
 * (lib/identity), limit (lib/rate-limit), run (lib/orchestrator), store
 * (lib/run-store). Every decision it makes is a pure function tested on its own.
 */

import { NextResponse } from "next/server";

import { tryGetDb } from "@/db";
import { appEnv } from "@/lib/env";
import { authorize, rateLimitKey } from "@/lib/identity";
import {
  type ContractFailure,
  checkBodySize,
  parseMissionBody,
  wantsEventStream,
  dailyCapFailure,
  rateLimitFailure,
} from "@/lib/mission-contract";
import { type MissionOptions, type RunEvent, runMission } from "@/lib/orchestrator";
import { consume, readDailyCap, readRateLimitRule } from "@/lib/rate-limit";
import { countRunsToday, persistRun } from "@/lib/run-store";

export const dynamic = "force-dynamic";

/** SSE comment frame. Keeps proxies from dropping a connection during a long call. */
const HEARTBEAT_MS = 15_000;

function fail(failure: ContractFailure) {
  return NextResponse.json(
    { error: failure.error },
    { status: failure.status, headers: failure.headers },
  );
}

export async function POST(request: Request) {
  const env = appEnv();

  const access = authorize(request.headers, env);
  if (!access.allowed) {
    return NextResponse.json({ error: access.error }, { status: access.status });
  }
  const identity = access.identity;

  const oversized = checkBodySize(request.headers);
  if (oversized) return fail(oversized);

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid mission request." }, { status: 400 });
  }

  const parsed = parseMissionBody(raw);
  if (!parsed.ok) return fail(parsed);
  const input = parsed.value;

  const verdict = consume(rateLimitKey(request.headers, identity), readRateLimitRule(env));
  if (!verdict.allowed) {
    return fail(rateLimitFailure(verdict.limit, verdict.retryAfterSeconds));
  }

  // Anonymous visitors never own rows in the shared database, so history and
  // the daily cap only apply to identities that can be told apart.
  const db = identity.persistable ? tryGetDb() : null;
  const dailyCap = readDailyCap(env);
  if (dailyCap > 0 && db) {
    const used = await countRunsToday(db, identity.userId);
    if (used >= dailyCap) return fail(dailyCapFailure(dailyCap));
  }

  const options: MissionOptions = {
    prompt: input.prompt,
    mode: input.mode,
    includeInbox: input.includeInbox,
    preferences: input.preferences,
    enabledProviders: input.enabledProviders,
    gatewayEnabled: input.gatewayEnabled,
    env,
    // A closed tab should stop the model calls, not keep paying for them.
    signal: request.signal,
  };

  async function store(event: RunEvent) {
    if (event.type !== "run.completed") return { stored: false as const };
    if (!identity.persistable) {
      return {
        stored: false as const,
        reason: "Sign in to keep run history beyond this browser.",
      };
    }
    return persistRun(db, identity, {
      runId: event.runId,
      createdAt: event.createdAt,
      prompt: input.prompt,
      mode: input.mode,
      connected: event.connected,
      status: "complete",
      summary: event.summary,
      finalDeliverable: event.finalDeliverable,
      agents: event.agents,
      approvals: event.approvals,
      routing: event.routing,
      totals: event.totals,
      workflow: event.workflow,
    });
  }

  if (wantsEventStream(request.url, request.headers)) {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        let open = true;
        // enqueue() throws once the client is gone; that is a normal ending.
        const write = (chunk: string) => {
          if (!open) return false;
          try {
            controller.enqueue(encoder.encode(chunk));
            return true;
          } catch {
            open = false;
            return false;
          }
        };
        const send = (payload: unknown) => write(`data: ${JSON.stringify(payload)}\n\n`);
        const heartbeat = setInterval(() => write(": keep-alive\n\n"), HEARTBEAT_MS);

        try {
          for await (const event of runMission(options)) {
            if (!send(event)) break;
            if (event.type === "run.completed") {
              const outcome = await store(event);
              send({ type: "persisted", ...outcome });
            }
          }
        } catch (error) {
          send({
            type: "run.failed",
            runId: "unknown",
            cancelled: request.signal.aborted,
            error:
              error instanceof Error
                ? `Agent run stopped safely: ${error.message}`
                : "Agent run stopped safely.",
          });
        } finally {
          clearInterval(heartbeat);
          write("data: [DONE]\n\n");
          if (open) {
            try {
              controller.close();
            } catch {
              // Already closed by the client disconnecting.
            }
          }
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  }

  let completed: Extract<RunEvent, { type: "run.completed" }> | null = null;
  let failed: Extract<RunEvent, { type: "run.failed" }> | null = null;
  for await (const event of runMission(options)) {
    if (event.type === "run.completed") completed = event;
    if (event.type === "run.failed") failed = event;
  }

  if (completed) {
    const persisted = await store(completed);
    return NextResponse.json({
      runId: completed.runId,
      createdAt: completed.createdAt,
      connected: completed.connected,
      summary: completed.summary,
      finalDeliverable: completed.finalDeliverable,
      agents: completed.agents,
      approvals: completed.approvals,
      routing: completed.routing,
      workflow: completed.workflow,
      totals: completed.totals,
      persisted,
    });
  }

  if (failed) {
    return NextResponse.json(
      { error: failed.error },
      { status: failed.cancelled ? 499 : 502 },
    );
  }

  return NextResponse.json({ error: "The mission produced no result." }, { status: 500 });
}
