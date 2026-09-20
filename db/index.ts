import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

export function getDb() {
  if (!env.DB) {
    throw new Error(
      "Cloudflare D1 binding `DB` is unavailable. Set the `d1` field in .openai/hosting.json to `DB` or let your control plane inject the real binding values before using the database."
    );
  }

  return drizzle(env.DB, { schema });
}

/**
 * Returns the database when one is bound, or null when the site is running
 * without D1. Callers use this to degrade to browser-local history instead of
 * failing a mission that otherwise succeeded.
 */
export function tryGetDb() {
  try {
    return env.DB ? drizzle(env.DB, { schema }) : null;
  } catch {
    return null;
  }
}

export type AppDatabase = ReturnType<typeof getDb>;
