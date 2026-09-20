/**
 * Model gateway client
 * --------------------
 * Everything that can hang, fail, or cost money lives here:
 *  - a hard per-call timeout (a Worker invocation must never wait forever),
 *  - bounded retries with exponential backoff that honours `Retry-After`,
 *  - an ordered provider fallback chain supplied by the router,
 *  - real usage and cost accounting taken from the provider response.
 *
 * `fetchImpl` and `sleepImpl` are injectable so the retry and fallback logic is
 * testable without a network or real timers.
 */

import {
  type AgentId,
  type EnvBag,
  type ModelProfile,
  type Provider,
  type RoutingDecision,
  getModelCatalog,
  profileFor,
  projectCost,
  providerNames,
} from "./model-router.ts";

export type GatewayConfig = {
  url: string;
  apiKey: string;
  timeoutMs: number;
  /** Attempts per provider, including the first one. */
  maxAttempts: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
};

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export type Usage = {
  inputTokens: number;
  outputTokens: number;
  /** True when the numbers were estimated locally because the provider omitted usage. */
  estimated: boolean;
};

export type GatewayAttempt = {
  provider: Provider;
  attempt: number;
  ok: boolean;
  status: number | null;
  error?: string;
  retryInMs?: number;
};

export type GatewayResult = {
  provider: Provider;
  model: string;
  content: string;
  usage: Usage;
  costUsd: number | null;
  latencyMs: number;
  attempts: GatewayAttempt[];
  /** Set when the first-choice provider did not serve the call. */
  fallbackFrom: Provider | null;
};

export class GatewayError extends Error {
  readonly attempts: GatewayAttempt[];
  readonly retryable: boolean;

  constructor(message: string, attempts: GatewayAttempt[], retryable: boolean) {
    super(message);
    this.name = "GatewayError";
    this.attempts = attempts;
    this.retryable = retryable;
  }
}

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);

function positiveInt(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export function readGatewayConfig(env?: EnvBag): GatewayConfig | null {
  const bag: EnvBag =
    env ?? (typeof process !== "undefined" && process.env ? process.env : {});
  const url = bag.LLM_GATEWAY_URL?.trim().replace(/\/+$/, "");
  const apiKey = bag.LLM_GATEWAY_API_KEY?.trim();
  if (!url || !apiKey) return null;
  return {
    url,
    apiKey,
    timeoutMs: positiveInt(bag.LLM_GATEWAY_TIMEOUT_MS, 45_000),
    maxAttempts: positiveInt(bag.LLM_GATEWAY_MAX_ATTEMPTS, 2),
    baseBackoffMs: positiveInt(bag.LLM_GATEWAY_BACKOFF_MS, 400),
    maxBackoffMs: positiveInt(bag.LLM_GATEWAY_MAX_BACKOFF_MS, 6_000),
  };
}

/** `Retry-After` may be seconds or an HTTP date. Returns null when unusable. */
export function parseRetryAfter(header: string | null, now = Date.now()): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 30_000);
  const at = Date.parse(header);
  if (Number.isNaN(at)) return null;
  return Math.max(0, Math.min(at - now, 30_000));
}

export function backoffDelay(
  attempt: number,
  config: Pick<GatewayConfig, "baseBackoffMs" | "maxBackoffMs">,
  random = Math.random,
) {
  const exponential = config.baseBackoffMs * 2 ** Math.max(0, attempt - 1);
  const capped = Math.min(exponential, config.maxBackoffMs);
  // Full jitter keeps parallel agents from retrying in lockstep.
  return Math.round(capped / 2 + random() * (capped / 2));
}

function defaultSleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Run cancelled"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new Error("Run cancelled"));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function estimateOutputTokens(text: string) {
  return Math.max(1, Math.ceil(text.length / 4));
}

type ChatCompletionPayload = {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    input_tokens?: number;
    output_tokens?: number;
  };
  error?: { message?: string };
};

export type CallOptions = {
  decision: RoutingDecision;
  agent: AgentId;
  messages: ChatMessage[];
  config: GatewayConfig;
  catalog?: ModelProfile[];
  allowedProviders?: Provider[];
  temperature?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  random?: () => number;
  onAttempt?: (attempt: GatewayAttempt) => void;
};

/**
 * Runs one agent call against the routed provider, then walks the fallback
 * chain. Each provider gets `maxAttempts` tries for retryable failures; a
 * non-retryable failure (bad key, unknown model) moves straight to the next
 * provider instead of burning the retry budget.
 */
export async function callModel(options: CallOptions): Promise<GatewayResult> {
  const {
    decision,
    messages,
    config,
    temperature = decision.agent === "verifier" ? 0.1 : 0.25,
    signal,
    fetchImpl = fetch,
    sleepImpl = defaultSleep,
    now = Date.now,
    random = Math.random,
    onAttempt,
  } = options;

  const catalog = options.catalog ?? getModelCatalog();
  const allowed = options.allowedProviders;
  const chain = [decision.provider, ...decision.alternatives].filter(
    (provider, index, list) =>
      list.indexOf(provider) === index && (!allowed || allowed.includes(provider)),
  );

  const attempts: GatewayAttempt[] = [];
  let lastMessage = "No configured provider was available for this agent.";

  for (const provider of chain) {
    const profile = profileFor(provider, catalog);
    if (!profile?.available || !profile.model) continue;

    for (let attempt = 1; attempt <= config.maxAttempts; attempt += 1) {
      if (signal?.aborted) throw new GatewayError("Run cancelled", attempts, false);

      const startedAt = now();
      const timeoutController = new AbortController();
      const timer = setTimeout(() => timeoutController.abort(), config.timeoutMs);
      const onOuterAbort = () => timeoutController.abort();
      signal?.addEventListener("abort", onOuterAbort, { once: true });

      try {
        const response = await fetchImpl(`${config.url}/chat/completions`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: profile.model,
            temperature,
            max_tokens: decision.maxOutputTokens,
            messages,
          }),
          signal: timeoutController.signal,
        });

        if (!response.ok) {
          const retryable = RETRYABLE_STATUS.has(response.status);
          const retryAfter = parseRetryAfter(
            response.headers?.get?.("retry-after") ?? null,
            now(),
          );
          const record: GatewayAttempt = {
            provider,
            attempt,
            ok: false,
            status: response.status,
            error: `${providerNames[provider]} returned ${response.status}`,
          };
          lastMessage = record.error!;
          if (retryable && attempt < config.maxAttempts) {
            record.retryInMs = retryAfter ?? backoffDelay(attempt, config, random);
            attempts.push(record);
            onAttempt?.(record);
            await sleepImpl(record.retryInMs, signal);
            continue;
          }
          attempts.push(record);
          onAttempt?.(record);
          break; // Next provider.
        }

        const payload = (await response.json()) as ChatCompletionPayload;
        const content = payload.choices?.[0]?.message?.content?.trim() ?? "";
        if (!content) {
          const record: GatewayAttempt = {
            provider,
            attempt,
            ok: false,
            status: response.status,
            error:
              payload.error?.message ??
              `${providerNames[provider]} returned an empty response`,
          };
          lastMessage = record.error!;
          attempts.push(record);
          onAttempt?.(record);
          break;
        }

        const promptTokens =
          payload.usage?.prompt_tokens ?? payload.usage?.input_tokens ?? null;
        const completionTokens =
          payload.usage?.completion_tokens ?? payload.usage?.output_tokens ?? null;
        const usage: Usage = {
          inputTokens: promptTokens ?? decision.estimatedInputTokens,
          outputTokens: completionTokens ?? estimateOutputTokens(content),
          estimated: promptTokens === null || completionTokens === null,
        };

        const record: GatewayAttempt = {
          provider,
          attempt,
          ok: true,
          status: response.status,
        };
        attempts.push(record);
        onAttempt?.(record);

        return {
          provider,
          model: profile.model,
          content,
          usage,
          costUsd: projectCost(profile, usage.inputTokens, usage.outputTokens),
          latencyMs: Math.max(0, now() - startedAt),
          attempts,
          fallbackFrom: provider === decision.provider ? null : decision.provider,
        };
      } catch (error) {
        const cancelled = signal?.aborted === true;
        const timedOut = !cancelled && timeoutController.signal.aborted;
        const message = cancelled
          ? "Run cancelled"
          : timedOut
            ? `${providerNames[provider]} timed out after ${config.timeoutMs} ms`
            : error instanceof Error
              ? error.message
              : String(error);
        const record: GatewayAttempt = {
          provider,
          attempt,
          ok: false,
          status: null,
          error: message,
        };
        lastMessage = message;

        if (cancelled) {
          attempts.push(record);
          onAttempt?.(record);
          throw new GatewayError("Run cancelled", attempts, false);
        }
        if (attempt < config.maxAttempts) {
          record.retryInMs = backoffDelay(attempt, config, random);
          attempts.push(record);
          onAttempt?.(record);
          await sleepImpl(record.retryInMs, signal);
          continue;
        }
        attempts.push(record);
        onAttempt?.(record);
        break;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onOuterAbort);
      }
    }
  }

  throw new GatewayError(`All model routes failed: ${lastMessage}`, attempts, true);
}
