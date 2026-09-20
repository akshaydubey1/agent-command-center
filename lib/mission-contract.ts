/**
 * Mission request contract
 * ------------------------
 * Everything the mission endpoint decides before any work starts — shape,
 * limits, authorisation, response format — lives here as pure functions, so
 * the rules can be tested without a server, a database, or a gateway.
 *
 * The route stays thin: parse, check, run.
 */

import type { EnvBag } from "./model-router.ts";
import { type AgentId, type ModelPreference, type Provider, allProviders } from "./model-router.ts";
import type { ApprovalMode } from "./orchestrator.ts";

export const MAX_PROMPT_LENGTH = 4000;
/** Bytes. A mission body is small; anything larger is a mistake or an attack. */
export const MAX_BODY_BYTES = 64 * 1024;

export type MissionInput = {
  prompt: string;
  mode: ApprovalMode;
  includeInbox: boolean;
  preferences: Record<AgentId, ModelPreference>;
  enabledProviders: Provider[];
  gatewayEnabled: boolean;
};

export type ContractFailure = {
  ok: false;
  status: number;
  error: string;
  headers?: Record<string, string>;
};

export type ContractSuccess = { ok: true; value: MissionInput };
export type ContractResult = ContractSuccess | ContractFailure;

const validPreferences = new Set<ModelPreference>(["auto", ...allProviders]);

export function cleanPreference(value: unknown): ModelPreference {
  return typeof value === "string" && validPreferences.has(value as ModelPreference)
    ? (value as ModelPreference)
    : "auto";
}

export function cleanProviders(value: unknown): Provider[] {
  if (!Array.isArray(value)) return allProviders;
  const filtered = value.filter(
    (candidate): candidate is Provider =>
      typeof candidate === "string" && allProviders.includes(candidate as Provider),
  );
  // De-duplicate: a repeated provider would be retried twice in the same chain.
  const unique = filtered.filter((p, i) => filtered.indexOf(p) === i);
  return unique.length > 0 ? unique : allProviders;
}

export function cleanMode(value: unknown): ApprovalMode {
  return value === "guarded" || value === "autonomous" || value === "prepare"
    ? value
    : "prepare";
}

/** Rejects a body that is too large to be a legitimate mission before parsing it. */
export function checkBodySize(headers: Headers): ContractFailure | null {
  const declared = Number(headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return {
      ok: false,
      status: 413,
      error: `Mission request must be under ${Math.floor(MAX_BODY_BYTES / 1024)} KB.`,
    };
  }
  return null;
}

/**
 * Validates and normalises a parsed body. Unknown fields are ignored, invalid
 * values fall back to safe defaults, and only the prompt can fail the request:
 * a caller should not be able to break a run by sending a bad enum.
 */
export function parseMissionBody(raw: unknown): ContractResult {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, status: 400, error: "Invalid mission request." };
  }
  const body = raw as Record<string, unknown>;

  if (body.prompt !== undefined && typeof body.prompt !== "string") {
    return { ok: false, status: 400, error: "Mission prompt must be text." };
  }
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) {
    return { ok: false, status: 400, error: "Add a mission before starting a run." };
  }
  if (prompt.length > MAX_PROMPT_LENGTH) {
    return {
      ok: false,
      status: 400,
      error: `Mission must be ${MAX_PROMPT_LENGTH.toLocaleString()} characters or fewer.`,
    };
  }

  const models = (body.models ?? {}) as Record<string, unknown>;
  const modelsObject = models !== null && typeof models === "object" && !Array.isArray(models);

  return {
    ok: true,
    value: {
      prompt,
      mode: cleanMode(body.mode),
      includeInbox: body.includeInbox !== false,
      preferences: {
        inbox: cleanPreference(modelsObject ? models.inbox : undefined),
        builder: cleanPreference(modelsObject ? models.builder : undefined),
        verifier: cleanPreference(modelsObject ? models.verifier : undefined),
        chief: cleanPreference(modelsObject ? models.chief : undefined),
      },
      enabledProviders: cleanProviders(body.enabledProviders),
      gatewayEnabled: body.modelGatewayEnabled !== false,
    },
  };
}

/** True when the caller asked for the event stream rather than one JSON body. */
export function wantsEventStream(url: string, headers: Headers) {
  let streamParam: string | null = null;
  try {
    streamParam = new URL(url).searchParams.get("stream");
  } catch {
    streamParam = null;
  }
  return streamParam === "1" || (headers.get("accept") ?? "").includes("text/event-stream");
}

export function rateLimitFailure(
  limit: number,
  retryAfterSeconds: number,
): ContractFailure {
  return {
    ok: false,
    status: 429,
    error: `Rate limit reached: ${limit} missions per minute. Try again in ${retryAfterSeconds}s.`,
    headers: { "Retry-After": String(retryAfterSeconds) },
  };
}

export function dailyCapFailure(cap: number): ContractFailure {
  return {
    ok: false,
    status: 429,
    error: `Daily limit reached: ${cap} missions in 24 hours.`,
  };
}

/** Reads the deployment's own limits without touching the network. */
export function describeLimits(env: EnvBag) {
  return {
    maxPromptLength: MAX_PROMPT_LENGTH,
    maxBodyBytes: MAX_BODY_BYTES,
    requiresSignIn: env.REQUIRE_SIGNED_IN === "true",
  };
}
