#!/usr/bin/env node
/**
 * Stand-in model gateway
 * ----------------------
 *   npm run gateway:fake -- --port 5399
 *
 * Speaks the OpenAI-compatible `/chat/completions` shape well enough to
 * exercise the live path end to end — routing, fallback, retries, token and
 * cost accounting, the Verifier revision loop — without an account, a key, or
 * a cent of spend. Use it to prove the wiring before pointing the app at a
 * real gateway.
 *
 * Behaviour is driven by the requested model id:
 *   *ok*      answers normally
 *   *slow*    answers after a delay (exercises timeouts)
 *   *429*     refuses twice with 429, then answers (exercises backoff)
 *   *down*    always refuses with 503 (exercises provider fallback)
 *   *401*     always refuses with 401 (exercises non-retryable failure)
 *   *revise*  as the Verifier, returns REVISE once, then PASS
 */

import { createServer } from "node:http";

const args = process.argv.slice(2);
const portArg = args.indexOf("--port");
const PORT = portArg !== -1 ? Number(args[portArg + 1]) : 5399;
const KEY = process.env.FAKE_GATEWAY_KEY ?? "local-test-key";

const attempts = new Map();
let reviseCount = 0;

function reply(model, role, prompt) {
  if (role === "verifier") {
    if (/revise/.test(model) && reviseCount === 0) {
      reviseCount += 1;
      return "VERDICT: REVISE\n1. Handle the timeout path explicitly.\n2. Add a test for the retry ceiling.";
    }
    return "VERDICT: PASS\nThe work meets the stated outcome; no corrections.";
  }
  if (role === "chief") return `Chief plan from ${model}: sequence the work, then package it for approval.`;
  if (role === "inbox") return `Inbox intake from ${model}: no message was sent or altered.`;
  return `Work product from ${model} for: ${prompt.slice(0, 80)}`;
}

function roleOf(messages) {
  const system = messages?.[0]?.content ?? "";
  if (system.includes("Verifier Agent")) return "verifier";
  if (system.includes("Chief Agent")) return "chief";
  if (system.includes("Inbox Agent")) return "inbox";
  return "builder";
}

const server = createServer((req, res) => {
  const send = (status, body, headers = {}) => {
    const payload = JSON.stringify(body);
    res.writeHead(status, { "Content-Type": "application/json", ...headers });
    res.end(payload);
  };

  if (req.method !== "POST" || !req.url.endsWith("/chat/completions")) {
    send(404, { error: { message: "Only POST /chat/completions is implemented." } });
    return;
  }

  if (req.headers.authorization !== `Bearer ${KEY}`) {
    send(401, { error: { message: "Bad or missing bearer key." } });
    return;
  }

  let raw = "";
  req.on("data", (chunk) => {
    raw += chunk;
    if (raw.length > 1_000_000) req.destroy();
  });

  req.on("end", async () => {
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      send(400, { error: { message: "Body was not JSON." } });
      return;
    }

    const model = String(body.model ?? "");
    const role = roleOf(body.messages);
    const prompt = body.messages?.[body.messages.length - 1]?.content ?? "";

    if (/401/.test(model)) {
      send(401, { error: { message: `No access to ${model}.` } });
      return;
    }
    if (/down/.test(model)) {
      send(503, { error: { message: `${model} is unavailable.` } });
      return;
    }
    if (/429/.test(model)) {
      const seen = (attempts.get(model) ?? 0) + 1;
      attempts.set(model, seen);
      if (seen <= 2) {
        send(429, { error: { message: "Slow down." } }, { "Retry-After": "1" });
        return;
      }
    }
    if (/slow/.test(model)) {
      await new Promise((r) => setTimeout(r, Number(process.env.FAKE_GATEWAY_DELAY_MS ?? 3000)));
    }

    const content = reply(model, role, prompt);
    send(200, {
      id: `fake-${Date.now()}`,
      object: "chat.completion",
      model,
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: Math.max(1, Math.ceil(String(prompt).length / 4)),
        completion_tokens: Math.max(1, Math.ceil(content.length / 4)),
      },
    });
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Stand-in gateway on http://127.0.0.1:${PORT}/v1  (key: ${KEY})`);
  console.log("Model id suffixes: ok | slow | 429 | down | 401 | revise");
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
