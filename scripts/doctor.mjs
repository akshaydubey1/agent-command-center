#!/usr/bin/env node
/**
 * Connection doctor
 * -----------------
 *   npm run doctor
 *
 * Answers one question honestly: which model routes are actually connected?
 * It reads .env, checks the gateway, then makes one real minimal call per
 * configured route and reports latency, token usage and cost — or the exact
 * reason that route is not usable.
 *
 * Nothing here is mocked. A route only passes if a provider answered.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const PROVIDERS = ["openai", "gemini", "claude", "perplexity"];
const LABEL = {
  openai: "OpenAI (ChatGPT models)",
  gemini: "Gemini",
  claude: "Claude",
  perplexity: "Perplexity",
};

const color = process.stdout.isTTY
  ? {
      pass: (s) => `\x1b[32m${s}\x1b[0m`,
      fail: (s) => `\x1b[31m${s}\x1b[0m`,
      warn: (s) => `\x1b[33m${s}\x1b[0m`,
      dim: (s) => `\x1b[2m${s}\x1b[0m`,
      bold: (s) => `\x1b[1m${s}\x1b[0m`,
    }
  : { pass: (s) => s, fail: (s) => s, warn: (s) => s, dim: (s) => s, bold: (s) => s };

/** Minimal .env reader: KEY=VALUE, # comments, optional quotes. */
function loadEnvFile(file) {
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return {};
  }
  const out = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

const fileEnv = loadEnvFile(resolve(process.cwd(), ".env"));
const env = { ...fileEnv, ...process.env };
const num = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

function redactUrl(raw) {
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return raw;
  }
}

async function probe(provider, gateway, key, timeoutMs) {
  const model = env[`MODEL_${provider.toUpperCase()}`]?.trim();
  const enabled = env[`MODEL_${provider.toUpperCase()}_ENABLED`] !== "false";

  if (!model) return { provider, status: "unconfigured", detail: `MODEL_${provider.toUpperCase()} is not set.` };
  if (!enabled) return { provider, status: "disabled", model, detail: `MODEL_${provider.toUpperCase()}_ENABLED=false` };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();

  try {
    const response = await fetch(`${gateway}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        max_tokens: 16,
        temperature: 0,
        messages: [
          { role: "system", content: "Reply with the single word: ready." },
          { role: "user", content: "Connection check." },
        ],
      }),
      signal: controller.signal,
    });

    const latencyMs = Date.now() - startedAt;
    const text = await response.text();

    if (!response.ok) {
      let detail = `HTTP ${response.status}`;
      try {
        const parsed = JSON.parse(text);
        if (parsed?.error?.message) detail += ` — ${parsed.error.message}`;
      } catch {
        if (text) detail += ` — ${text.slice(0, 160)}`;
      }
      if (response.status === 401 || response.status === 403) {
        detail += " (the gateway rejected the key, or the key lacks this model)";
      }
      if (response.status === 404) {
        detail += " (the gateway does not know this model id)";
      }
      return { provider, status: "error", model, latencyMs, detail };
    }

    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      return { provider, status: "error", model, latencyMs, detail: "Response was not JSON." };
    }

    const content = payload?.choices?.[0]?.message?.content?.trim();
    if (!content) {
      return { provider, status: "error", model, latencyMs, detail: "Provider returned an empty completion." };
    }

    const usage = payload.usage ?? {};
    const inTok = usage.prompt_tokens ?? usage.input_tokens ?? null;
    const outTok = usage.completion_tokens ?? usage.output_tokens ?? null;
    const inCost = Number(env[`MODEL_${provider.toUpperCase()}_INPUT_COST_PER_M`]);
    const outCost = Number(env[`MODEL_${provider.toUpperCase()}_OUTPUT_COST_PER_M`]);
    const costUsd =
      Number.isFinite(inCost) && Number.isFinite(outCost) && inTok !== null && outTok !== null
        ? (inTok / 1e6) * inCost + (outTok / 1e6) * outCost
        : null;

    return {
      provider,
      status: "connected",
      model,
      latencyMs,
      reply: content.slice(0, 60),
      inTok,
      outTok,
      costUsd,
    };
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    const aborted = controller.signal.aborted;
    return {
      provider,
      status: "error",
      model,
      latencyMs,
      detail: aborted
        ? `No response within ${timeoutMs} ms.`
        : `${error?.cause?.code ?? error?.name ?? "Error"}: ${error?.message ?? String(error)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  console.log(color.bold("\nAgent Command Center — connection doctor"));
  console.log(color.dim("Model route connectivity check\n"));

  const gateway = env.LLM_GATEWAY_URL?.trim().replace(/\/+$/, "");
  const key = env.LLM_GATEWAY_API_KEY?.trim();
  const timeoutMs = num(env.LLM_GATEWAY_TIMEOUT_MS, 30_000);

  if (!gateway || !key) {
    console.log(color.warn("  Gateway: not configured"));
    console.log(
      color.dim(
        "  Set LLM_GATEWAY_URL and LLM_GATEWAY_API_KEY in .env, plus a model id per route.\n" +
          "  Until then the app runs its routing preview: classification, agent\n" +
          "  minimization and approvals all work; no provider is called.\n",
      ),
    );
    console.log(color.dim("  Nothing is broken — there is simply no gateway to reach yet.\n"));
    process.exit(1);
  }

  console.log(`  Gateway   ${redactUrl(gateway)}`);
  console.log(`  Key       ${color.dim(key.slice(0, 4) + "…" + key.slice(-2) + ` (${key.length} chars)`)}`);
  console.log(`  Timeout   ${timeoutMs} ms\n`);

  const results = await Promise.all(
    PROVIDERS.map((provider) => probe(provider, gateway, key, timeoutMs)),
  );

  let connected = 0;
  for (const r of results) {
    const name = LABEL[r.provider].padEnd(24);
    if (r.status === "connected") {
      connected += 1;
      const cost = r.costUsd !== null ? ` · $${r.costUsd.toFixed(6)}` : "";
      const tokens = r.inTok !== null ? ` · ${r.inTok}+${r.outTok} tok` : "";
      console.log(`  ${color.pass("connected   ")} ${name} ${color.dim(r.model)}`);
      console.log(`  ${" ".repeat(12)} ${" ".repeat(24)} ${color.dim(`${r.latencyMs} ms${tokens}${cost} · replied "${r.reply}"`)}`);
    } else if (r.status === "unconfigured") {
      console.log(`  ${color.dim("not set     ")} ${name} ${color.dim(r.detail)}`);
    } else if (r.status === "disabled") {
      console.log(`  ${color.warn("disabled    ")} ${name} ${color.dim(r.detail)}`);
    } else {
      console.log(`  ${color.fail("failed      ")} ${name} ${color.dim(r.model ?? "")}`);
      console.log(`  ${" ".repeat(12)} ${" ".repeat(24)} ${color.fail(r.detail)}`);
    }
  }

  console.log("");
  const configured = results.filter((r) => r.status !== "unconfigured").length;
  if (connected === 0) {
    console.log(color.fail(`  No route answered. Auto Router has nothing live to call.\n`));
    process.exit(1);
  }

  console.log(
    color.pass(`  ${connected} of ${configured} configured route(s) answered.`) +
      color.dim(" Auto Router will use these and fall back between them.\n"),
  );

  const failing = results.filter((r) => r.status === "error");
  if (failing.length > 0) {
    console.log(color.warn("  Fix or disable the failing routes so the router stops trying them:"));
    for (const r of failing) {
      console.log(color.dim(`    MODEL_${r.provider.toUpperCase()}_ENABLED=false   # or correct MODEL_${r.provider.toUpperCase()}`));
    }
    console.log("");
  }
  process.exit(0);
}

main().catch((error) => {
  console.error(color.fail(`\n  Doctor could not run: ${error?.message ?? error}\n`));
  process.exit(1);
});
