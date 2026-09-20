/**
 * Rate limiting
 * -------------
 * A mission can trigger up to six model calls, so an unprotected public
 * endpoint is a direct line to the gateway bill.
 *
 * Two layers:
 *  1. An in-memory sliding window per identity. Cheap and instant, but a Worker
 *     isolate is per-colo and short-lived, so treat it as burst protection
 *     rather than a guarantee.
 *  2. A durable daily cap counted in D1 (see `countRunsToday`), applied by the
 *     mission route when a database is bound.
 */

import type { EnvBag } from "./model-router.ts";

export type RateLimitRule = { limit: number; windowMs: number };

export type RateLimitVerdict = {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
  limit: number;
};

type Bucket = number[];

const buckets = new Map<string, Bucket>();

function positiveInt(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

export function readRateLimitRule(env: EnvBag = {}): RateLimitRule {
  return {
    limit: positiveInt(env.RATE_LIMIT_RUNS_PER_MINUTE, 6),
    windowMs: positiveInt(env.RATE_LIMIT_WINDOW_MS, 60_000),
  };
}

export function readDailyCap(env: EnvBag = {}) {
  return positiveInt(env.RATE_LIMIT_RUNS_PER_DAY, 120);
}

/** Records an attempt and reports whether it is allowed. */
export function consume(
  key: string,
  rule: RateLimitRule,
  now = Date.now(),
  store = buckets,
): RateLimitVerdict {
  if (rule.limit === 0) {
    return { allowed: true, remaining: Number.POSITIVE_INFINITY, retryAfterSeconds: 0, limit: 0 };
  }
  const cutoff = now - rule.windowMs;
  const recent = (store.get(key) ?? []).filter((stamp) => stamp > cutoff);

  if (recent.length >= rule.limit) {
    store.set(key, recent);
    const oldest = recent[0];
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil((oldest + rule.windowMs - now) / 1000)),
      limit: rule.limit,
    };
  }

  recent.push(now);
  store.set(key, recent);

  // Opportunistic cleanup so a long-lived isolate does not grow unbounded.
  if (store.size > 500) {
    for (const [existingKey, stamps] of store) {
      if (stamps.every((stamp) => stamp <= cutoff)) store.delete(existingKey);
    }
  }

  return {
    allowed: true,
    remaining: rule.limit - recent.length,
    retryAfterSeconds: 0,
    limit: rule.limit,
  };
}

export function resetRateLimits() {
  buckets.clear();
}
