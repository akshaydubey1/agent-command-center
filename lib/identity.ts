/**
 * Visitor identity
 * ----------------
 * Signed-in visitors arrive with platform-injected headers. The user id is the
 * durable key for stored records; email and name are display values only.
 *
 * Set `REQUIRE_SIGNED_IN=true` to refuse anonymous mission runs, and
 * `MISSION_API_TOKEN` to allow scripted callers that present the matching
 * `x-mission-token` header. Without one of those, a public deployment lets
 * anyone spend the gateway budget.
 *
 * TENANCY: every anonymous visitor would otherwise share the single owner id
 * "anonymous", which would let one of them read another's stored runs. So an
 * anonymous identity is never `persistable`: its runs stay in its own browser
 * and never reach the shared database. Storage is a signed-in feature.
 */

import type { EnvBag } from "./model-router.ts";

export type Identity = {
  userId: string;
  email: string | null;
  fullName: string | null;
  anonymous: boolean;
  viaToken: boolean;
  /** Whether this identity may own rows in the shared database. */
  persistable: boolean;
};

const USER_ID_HEADER = "oai-authenticated-user-id";
const EMAIL_HEADER = "oai-authenticated-user-email";
const FULL_NAME_HEADER = "oai-authenticated-user-full-name";
const FULL_NAME_ENCODING_HEADER = "oai-authenticated-user-full-name-encoding";
const TOKEN_HEADER = "x-mission-token";

function decodeFullName(headers: Headers) {
  const encoded = headers.get(FULL_NAME_HEADER);
  if (!encoded) return null;
  if (headers.get(FULL_NAME_ENCODING_HEADER) !== "percent-encoded-utf-8") {
    return encoded;
  }
  try {
    return decodeURIComponent(encoded);
  } catch {
    return null;
  }
}

/** Length-independent comparison so a token check does not leak by timing. */
function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) {
    diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return diff === 0;
}

export function identityFrom(headers: Headers, env: EnvBag = {}): Identity {
  const userId = headers.get(USER_ID_HEADER)?.trim();
  const configuredToken = env.MISSION_API_TOKEN?.trim();
  const presentedToken = headers.get(TOKEN_HEADER)?.trim();
  const viaToken = Boolean(
    configuredToken && presentedToken && safeEqual(configuredToken, presentedToken),
  );

  if (userId) {
    return {
      userId,
      email: headers.get(EMAIL_HEADER),
      fullName: decodeFullName(headers),
      anonymous: false,
      viaToken,
      persistable: true,
    };
  }

  if (viaToken) {
    return {
      userId: "service-token",
      email: null,
      fullName: null,
      anonymous: false,
      viaToken: true,
      persistable: true,
    };
  }

  return {
    userId: "anonymous",
    email: null,
    fullName: null,
    anonymous: true,
    viaToken: false,
    persistable: false,
  };
}

/**
 * The bucket a rate limit counts against. Signed-in callers are limited per
 * account; anonymous callers per client address, so one visitor cannot exhaust
 * the allowance for everyone else sharing the "anonymous" id.
 */
export function rateLimitKey(headers: Headers, identity: Identity) {
  if (!identity.anonymous) return `user:${identity.userId}`;
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const address = headers.get("cf-connecting-ip")?.trim() || forwarded || "unknown";
  return `ip:${address}`;
}

export type AccessDecision =
  | { allowed: true; identity: Identity }
  | { allowed: false; identity: Identity; status: number; error: string };

export function authorize(headers: Headers, env: EnvBag = {}): AccessDecision {
  const identity = identityFrom(headers, env);
  const requiresSignIn = env.REQUIRE_SIGNED_IN === "true";
  if (requiresSignIn && identity.anonymous) {
    return {
      allowed: false,
      identity,
      status: 401,
      error: "Sign in to run a mission on this workspace.",
    };
  }
  return { allowed: true, identity };
}
