/**
 * GET /api/status
 * Lets the dashboard show real deployment state on load instead of guessing:
 * whether the gateway is live, which providers are actually configured, whether
 * run history is durable, and what the limits are. Never returns secrets, and
 * exact model identifiers are withheld from anonymous visitors.
 */

import { NextResponse } from "next/server";

import { tryGetDb } from "@/db";
import { appEnv } from "@/lib/env";
import { identityFrom } from "@/lib/identity";
import { readGatewayConfig } from "@/lib/gateway";
import { getModelCatalog } from "@/lib/model-router";
import { ownerName } from "@/lib/orchestrator";
import { readDailyCap, readRateLimitRule } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const env = appEnv();
  const identity = identityFrom(request.headers, env);
  const gateway = readGatewayConfig(env);
  const catalog = getModelCatalog(env);
  const rule = readRateLimitRule(env);

  return NextResponse.json({
    owner: ownerName(env),
    gateway: {
      configured: Boolean(gateway),
      timeoutMs: gateway?.timeoutMs ?? null,
      maxAttempts: gateway?.maxAttempts ?? null,
    },
    live: Boolean(gateway) && catalog.some((profile) => profile.available),
    providers: catalog.map((profile) => ({
      provider: profile.provider,
      configured: Boolean(profile.model),
      available: profile.available,
      costTier: profile.costTier,
      contextWindow: profile.contextWindow,
      hasPricing:
        profile.inputCostPerMillion !== null && profile.outputCostPerMillion !== null,
      model: identity.anonymous ? null : profile.model,
    })),
    storage: {
      // Durable for this viewer: a database exists AND this identity may own rows.
      durable: Boolean(tryGetDb()) && identity.persistable,
      configured: Boolean(tryGetDb()),
    },
    limits: { perMinute: rule.limit, perDay: readDailyCap(env) },
    identity: {
      signedIn: !identity.anonymous,
      email: identity.email,
      fullName: identity.fullName,
    },
    requiresSignIn: env.REQUIRE_SIGNED_IN === "true",
  });
}
