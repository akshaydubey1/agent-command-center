import type { EnvBag } from "./model-router.ts";

/**
 * Reads deployment configuration. `process.env` is not guaranteed to exist in
 * every Worker context, so this never throws and always returns a bag.
 */
export function appEnv(): EnvBag {
  return typeof process !== "undefined" && process.env
    ? (process.env as EnvBag)
    : {};
}
