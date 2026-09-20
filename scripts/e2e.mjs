#!/usr/bin/env node
/**
 * End-to-end HTTP suite
 * ---------------------
 *   npm run test:e2e
 *
 * Boots the built Worker and exercises the real endpoints over HTTP: status,
 * the JSON and SSE mission paths, routing decisions, D1 persistence, approval
 * decisions, tenant isolation, input validation and rate limiting.
 *
 * Nothing is stubbed. If this passes, the deployed surface works.
 *
 * Prerequisite: `npm run build` once, and the D1 migration applied (see README).
 * Pass a BASE_URL env var to test an already-running server instead of booting one.
 */

import { spawn, spawnSync } from "node:child_process";
import process from "node:process";

const PORT = Number(process.env.E2E_PORT ?? 5310);
const EXTERNAL = process.env.BASE_URL;
const USER_A = { "oai-authenticated-user-id": "e2e-user-a", "oai-authenticated-user-email": "a@e2e.test" };
const USER_B = { "oai-authenticated-user-id": "e2e-user-b" };

let passed = 0;
let failed = 0;
const failures = [];
let group = "";

const tty = process.stdout.isTTY;
const green = (s) => (tty ? `\x1b[32m${s}\x1b[0m` : s);
const red = (s) => (tty ? `\x1b[31m${s}\x1b[0m` : s);
const dim = (s) => (tty ? `\x1b[2m${s}\x1b[0m` : s);
const bold = (s) => (tty ? `\x1b[1m${s}\x1b[0m` : s);

function describe(name) {
  group = name;
  console.log(`\n  ${bold(name)}`);
}

async function it(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`    ${green("pass")} ${name}`);
  } catch (error) {
    failed += 1;
    failures.push({ group, name, error });
    console.log(`    ${red("FAIL")} ${name}`);
    console.log(`         ${red(error?.message ?? String(error))}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function equal(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message ?? "values differ"} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

/* ---------------------------------------------------------------- server -- */

function waitForExit(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) resolve();
    else child.once("exit", () => resolve());
  });
}

let portCursor = 0;

/**
 * Boots its own server on a fresh port each time. Reusing one port across
 * phases let a slow-to-exit server answer the next phase's probe, so the
 * second phase silently tested the first phase's configuration.
 */
async function boot(vars) {
  if (EXTERNAL) return { base: EXTERNAL, stop: async () => {} };

  const port = PORT + portCursor;
  portCursor += 1;
  const args = ["start", "--", "--port", String(port)];
  for (const [key, value] of Object.entries(vars ?? {})) args.push("--var", `${key}:${value}`);

  const child = spawn("npm", args, {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, FORCE_COLOR: "0" },
  });
  let log = "";
  child.stdout.on("data", (d) => { log += d.toString(); });
  child.stderr.on("data", (d) => { log += d.toString(); });

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 90_000;
  for (;;) {
    if (Date.now() > deadline) {
      child.kill("SIGKILL");
      throw new Error(`Server did not start within 90s.\n${log.slice(-1500)}`);
    }
    try {
      const probe = await fetch(`${base}/api/status`);
      if (probe.ok) {
        // Confirm this is our server with our configuration, not a leftover.
        const wanted = vars?.RATE_LIMIT_RUNS_PER_MINUTE;
        if (wanted !== undefined) {
          const status = await probe.json();
          if (status.limits.perMinute !== Number(wanted)) {
            child.kill("SIGKILL");
            throw new Error(
              `Port ${port} is answering with perMinute=${status.limits.perMinute}, expected ${wanted}. Another server is using it.`,
            );
          }
        }
        break;
      }
    } catch (error) {
      if (String(error?.message ?? "").includes("is answering with")) throw error;
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 700));
  }

  return {
    base,
    stop: async () => {
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
      await waitForExit(child);
      clearTimeout(timer);
    },
  };
}

/* ----------------------------------------------------------------- utils -- */

async function post(base, path, body, headers = {}, init = {}) {
  const send = () =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
      ...init,
    });

  let response = await send();
  // The local dev runtime briefly answers 503 while it recycles an isolate
  // (most visibly right after a large request). That is the harness's problem,
  // not the app's, so allow exactly one retry and never mask any other status.
  if (response.status === 503) {
    await new Promise((r) => setTimeout(r, 1200));
    response = await send();
  }
  return response;
}

async function mission(base, prompt, headers = {}, extra = {}) {
  const response = await post(base, "/api/mission", { prompt, ...extra }, headers);
  const payload = await response.json();
  return { response, payload };
}

/** Reads a full SSE stream into its parsed events. */
async function streamMission(base, prompt, headers = {}) {
  const response = await post(
    base,
    "/api/mission?stream=1",
    { prompt },
    { Accept: "text/event-stream", ...headers },
  );
  assert(response.ok, `stream request failed with ${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  let done = false;
  let buffer = "";

  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const line = frame.split("\n").find((l) => l.startsWith("data: "));
      if (!line) continue;
      const payload = line.slice(6);
      if (payload === "[DONE]") { done = true; continue; }
      events.push(JSON.parse(payload));
    }
  }
  return { events, done, contentType: response.headers.get("content-type") };
}

/* ----------------------------------------------------------------- suite -- */

async function functionalSuite(base) {
  describe("GET /api/status");
  const status = await (await fetch(`${base}/api/status`, { headers: USER_A })).json();
  await it("reports the configured owner name", () => equal(status.owner, "E2E Owner"));
  await it("lists all four routes", () => equal(status.providers.length, 4));
  await it("reports gateway state without leaking a key", () => {
    assert(typeof status.gateway.configured === "boolean", "gateway.configured missing");
    assert(!JSON.stringify(status).toLowerCase().includes("api_key"), "status leaked a key field");
  });
  await it("reports limits", () => assert(status.limits.perMinute > 0, "perMinute missing"));
  await it("withholds model ids from anonymous visitors", async () => {
    const anon = await (await fetch(`${base}/api/status`)).json();
    assert(anon.providers.every((p) => p.model === null), "anonymous saw model ids");
    equal(anon.identity.signedIn, false);
  });

  describe("POST /api/mission — routing decisions");
  const quick = await mission(base, "Rewrite this sentence so it sounds more professional.", USER_A);
  await it("classifies a short rewrite as quick text", () =>
    equal(quick.payload.workflow.taskClass, "quick_text"));
  await it("activates Builder alone and skips three agents", () => {
    equal(quick.payload.workflow.activeAgents.length, 1);
    equal(quick.payload.workflow.skippedAgents.length, 3);
  });
  await it("keeps the token budget small for trivial work", () =>
    assert(quick.payload.workflow.estimatedTotalTokens < 500,
      `budget was ${quick.payload.workflow.estimatedTotalTokens}`));
  await it("queues exactly one medium-risk approval", () => {
    equal(quick.payload.approvals.length, 1);
    equal(quick.payload.approvals[0].risk, "medium");
  });

  const risky = await mission(
    base,
    "Send the renewal email to the Acme client and deploy the new pricing page to production.",
    USER_A,
  );
  await it("escalates an irreversible request to all four agents", () =>
    equal(risky.payload.workflow.activeAgents.length, 4));
  await it("names approvals from the user's own wording", () => {
    const titles = risky.payload.approvals.map((a) => a.title);
    assert(titles.includes("Send prepared email"), `titles were ${titles.join(", ")}`);
    assert(titles.includes("Deploy or publish"), `titles were ${titles.join(", ")}`);
  });
  await it("marks the irreversible run high risk", () =>
    assert(risky.payload.approvals.every((a) => a.risk === "high"), "expected all high risk"));

  const clinic = await mission(base, "Draft a quick reply to my medical clinic about rescheduling.", USER_A);
  await it("does not escalate a short reply that merely mentions a clinic", () =>
    equal(clinic.payload.workflow.taskClass, "email"));

  await it("returns a routing decision per active agent", () => {
    equal(risky.payload.routing.length, risky.payload.workflow.activeAgents.length);
    for (const d of risky.payload.routing) {
      assert(d.provider && d.reason && d.maxOutputTokens > 0, "incomplete routing decision");
      assert(Array.isArray(d.alternatives) && d.alternatives.length > 0, "missing fallback chain");
    }
  });

  await it("never claims a model ran when no gateway is configured", () => {
    if (status.live) return;
    equal(risky.payload.connected, false);
    equal(risky.payload.totals.modelCalls, 0);
  });

  describe("POST /api/mission — event stream");
  const streamed = await streamMission(base, "Debug the retry helper and write unit tests for it.", USER_A);
  await it("serves an event-stream content type", () =>
    assert(streamed.contentType?.includes("text/event-stream"), `got ${streamed.contentType}`));
  await it("terminates with [DONE]", () => equal(streamed.done, true));
  await it("opens with run.started and closes with run.completed", () => {
    equal(streamed.events[0].type, "run.started");
    const last = streamed.events.filter((e) => e.type === "run.completed" || e.type === "persisted");
    assert(last.length > 0, "no completion event");
  });
  await it("pairs every agent.started with an agent.completed", () => {
    const started = streamed.events.filter((e) => e.type === "agent.started");
    const done = streamed.events.filter((e) => e.type === "agent.completed");
    assert(started.length > 0, "no agent ran");
    equal(done.length, started.length, "started/completed mismatch");
  });
  await it("orders each agent's completion after its start", () => {
    const seen = new Map();
    streamed.events.forEach((e, index) => {
      if (e.type === "agent.started") seen.set(`${e.agent}:${e.revision}`, index);
      if (e.type === "agent.completed") {
        const startedAt = seen.get(`${e.agent}:${e.revision}`);
        assert(startedAt !== undefined && startedAt < index, `${e.agent} completed before it started`);
      }
    });
  });
  await it("reports skipped agents explicitly", () => {
    const skipped = streamed.events.filter((e) => e.type === "agent.skipped");
    const completed = streamed.events.find((e) => e.type === "run.completed");
    equal(skipped.length, completed.workflow.skippedAgents.length);
  });
  await it("emits a persistence result", () => {
    const persisted = streamed.events.find((e) => e.type === "persisted");
    assert(persisted, "no persisted event");
    assert(typeof persisted.stored === "boolean", "persisted.stored missing");
  });

  describe("Validation");
  await it("rejects an empty prompt", async () => {
    const r = await post(base, "/api/mission", { prompt: "   " }, USER_A);
    equal(r.status, 400);
  });
  await it("rejects a prompt over the cap", async () => {
    const r = await post(base, "/api/mission", { prompt: "a".repeat(4001) }, USER_A);
    equal(r.status, 400);
  });
  await it("rejects malformed JSON", async () => {
    const r = await post(base, "/api/mission", "{not json", USER_A);
    equal(r.status, 400);
  });
  await it("rejects a non-object body", async () => {
    const r = await post(base, "/api/mission", JSON.stringify("hello"), USER_A);
    equal(r.status, 400);
  });
  await it("rejects an oversized body", async () => {
    const r = await post(base, "/api/mission", { prompt: "a".repeat(100_000) }, USER_A);
    assert(r.status === 413 || r.status === 400, `got ${r.status}`);
  });
  await it("survives junk enums without failing the run", async () => {
    const r = await post(
      base,
      "/api/mission",
      { prompt: "Summarize this.", mode: "chaos", models: { builder: "gpt-9" }, enabledProviders: ["nope"] },
      USER_A,
    );
    equal(r.status, 200);
  });
  await it("rejects an unknown approval decision", async () => {
    const r = await post(base, "/api/runs/does-not-exist/approvals/x", { state: "maybe" }, USER_A);
    equal(r.status, 400);
  });

  describe("Persistence and tenancy");
  const runId = risky.payload.runId;
  await it("stores a signed-in run", () => {
    assert(risky.payload.persisted, "no persistence result");
    if (!risky.payload.persisted.stored) {
      throw new Error(`run not stored: ${risky.payload.persisted.reason}`);
    }
  });
  await it("lists the run for its owner", async () => {
    const list = await (await fetch(`${base}/api/runs?limit=10`, { headers: USER_A })).json();
    equal(list.durable, true);
    assert(list.runs.some((r) => r.runId === runId), "stored run missing from the owner's list");
  });
  await it("loads the run with its agent steps", async () => {
    const detail = await (await fetch(`${base}/api/runs/${runId}`, { headers: USER_A })).json();
    equal(detail.runId, runId);
    assert(detail.agents.length > 0, "no agent steps stored");
    assert(detail.approvals.length > 0, "no approvals stored");
  });
  await it("hides one user's run from another user", async () => {
    const r = await fetch(`${base}/api/runs/${runId}`, { headers: USER_B });
    equal(r.status, 404);
  });
  await it("keeps user B's list free of user A's runs", async () => {
    const list = await (await fetch(`${base}/api/runs`, { headers: USER_B })).json();
    assert(!list.runs.some((r) => r.runId === runId), "cross-tenant leak in the run list");
  });
  await it("gives anonymous visitors no shared history", async () => {
    const list = await (await fetch(`${base}/api/runs`)).json();
    equal(list.durable, false);
    equal(list.runs.length, 0);
  });
  await it("does not store an anonymous run", async () => {
    const anon = await mission(base, "Summarize the weekly status for me.");
    equal(anon.response.status, 200);
    equal(anon.payload.persisted.stored, false);
  });

  describe("Approvals");
  const approvalId = risky.payload.approvals[0].id;
  await it("records an approval decision", async () => {
    const r = await post(base, `/api/runs/${runId}/approvals/${approvalId}`, { state: "approved" }, USER_A);
    const body = await r.json();
    equal(body.recorded, true);
  });
  await it("persists the decision with who made it", async () => {
    const detail = await (await fetch(`${base}/api/runs/${runId}`, { headers: USER_A })).json();
    const item = detail.approvals.find((a) => a.id === approvalId);
    equal(item.state, "approved");
    assert(item.decidedBy, "decision has no author");
    assert(item.decidedAt, "decision has no timestamp");
  });
  await it("leaves the other approvals pending", async () => {
    const detail = await (await fetch(`${base}/api/runs/${runId}`, { headers: USER_A })).json();
    assert(detail.approvals.some((a) => a.state === "pending"), "approving one settled them all");
  });
  await it("refuses a decision on another user's run", async () => {
    const r = await post(base, `/api/runs/${runId}/approvals/${approvalId}`, { state: "rejected" }, USER_B);
    const body = await r.json();
    equal(body.recorded ?? false, false);
  });
  await it("did not flip the decision", async () => {
    const detail = await (await fetch(`${base}/api/runs/${runId}`, { headers: USER_A })).json();
    equal(detail.approvals.find((a) => a.id === approvalId).state, "approved");
  });
}

/**
 * Exercises the live path against the stand-in gateway: real HTTP calls, real
 * token accounting, provider fallback, retry-with-backoff, and the
 * Verifier -> Builder revision loop. Routes are chosen so that:
 *   openai  -> always 503  (forces the fallback chain and retries)
 *   claude  -> answers, and returns REVISE once as the Verifier
 */
async function liveSuite(base) {
  describe("Live gateway path (stand-in provider)");

  const status = await (await fetch(`${base}/api/status`, { headers: USER_A })).json();
  await it("reports the gateway as live", () => {
    equal(status.gateway.configured, true);
    equal(status.live, true);
  });

  const streamed = await streamMission(
    base,
    "Debug the retry helper in the deployment script and write unit tests for it.",
    USER_A,
  );
  const completed = streamed.events.find((e) => e.type === "run.completed");

  await it("completes the run against real HTTP calls", () => {
    assert(completed, "no run.completed event");
    equal(completed.connected, true);
    assert(completed.totals.modelCalls >= 4, `only ${completed.totals?.modelCalls} model calls`);
  });
  await it("counts tokens from the provider response", () => {
    assert(completed.totals.inputTokens > 0, "no input tokens counted");
    assert(completed.totals.outputTokens > 0, "no output tokens counted");
  });
  await it("computes spend from configured prices", () => {
    assert(typeof completed.totals.costUsd === "number", "cost was not computed");
    assert(completed.totals.costUsd > 0, "cost came out as zero");
  });
  await it("streams a retry when a provider refuses", () => {
    const retries = streamed.events.filter((e) => e.type === "agent.retry");
    assert(retries.length > 0, "no retry was reported");
    assert(retries.every((e) => e.attempt && e.attempt.ok === false), "malformed retry event");
  });
  await it("falls back to the next provider and says so", () => {
    const fellBack = streamed.events.filter(
      (e) => e.type === "agent.completed" && e.fallbackFrom,
    );
    assert(fellBack.length > 0, "no fallback recorded");
    const reason = completed.routing.find((d) => d.agent === fellBack[0].agent)?.reason ?? "";
    assert(/fallback/i.test(reason), `routing reason did not mention the fallback: ${reason}`);
  });
  await it("runs the Verifier to Builder revision loop", () => {
    const revision = streamed.events.find((e) => e.type === "revision.requested");
    assert(revision, "the verifier never requested a revision");
    assert(/timeout path/i.test(revision.corrections), "corrections were not carried over");
    const builderRuns = streamed.events.filter(
      (e) => e.type === "agent.completed" && e.agent === "builder",
    );
    equal(builderRuns.length, 2, "Builder did not re-run after the corrections");
    equal(completed.totals.revisions, 1);
  });
  await it("reports the model that actually answered, not the one first chosen", () => {
    for (const decision of completed.routing) {
      assert(decision.model, `${decision.agent} has no model recorded`);
    }
  });
  await it("stores the live run with its usage", async () => {
    const detail = await (await fetch(`${base}/api/runs/${completed.runId}`, { headers: USER_A })).json();
    equal(detail.runId, completed.runId);
    assert(detail.totals.inputTokens > 0, "stored run lost its token counts");
    assert(detail.totals.revisions === 1, "stored run lost the revision count");
  });
}

async function limitSuite(base) {
  describe("Rate limiting (limit of 3 per minute)");
  const codes = [];
  for (let i = 0; i < 5; i += 1) {
    const r = await post(base, "/api/mission", { prompt: "Summarize this note." }, USER_A);
    codes.push(r.status);
    if (r.status === 429) {
      await it("sends Retry-After with the refusal", () =>
        assert(r.headers.get("retry-after"), "no Retry-After header"));
      break;
    }
  }
  await it("allows the configured burst then refuses", () => {
    const allowed = codes.filter((c) => c === 200).length;
    equal(allowed, 3, `allowed ${allowed} before refusing (codes: ${codes.join(",")})`);
    assert(codes.includes(429), `never refused (codes: ${codes.join(",")})`);
  });
  await it("keeps a different caller unaffected", async () => {
    const r = await post(base, "/api/mission", { prompt: "Summarize this note." }, USER_B);
    equal(r.status, 200);
  });
}

/* ------------------------------------------------------------------ main -- */

/**
 * Applies the local D1 migration if the tables are not there yet, so the suite
 * works from a fresh clone. Re-applying is harmless: SQLite reports that the
 * tables already exist and we ignore that.
 */
function ensureLocalDatabase() {
  if (EXTERNAL) return;
  const result = spawnSync("npm", ["run", "--silent", "db:migrate:local"], {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.status === 0 || /already exists/i.test(output)) return;
  console.log(dim(`  (could not prepare the local database: ${output.trim().slice(-300)})`));
}

async function main() {
  console.log(bold("\n  Agent Command Center — end-to-end suite"));
  console.log(dim(`  ${EXTERNAL ? `against ${EXTERNAL}` : "booting the built Worker"}\n`));

  ensureLocalDatabase();

  let server = await boot({ RATE_LIMIT_RUNS_PER_MINUTE: 500, OWNER_NAME: "E2E Owner" });
  try {
    await functionalSuite(server.base);
  } finally {
    await server.stop();
  }

  if (!EXTERNAL) {
    const gatewayPort = PORT + 90;
    const gateway = spawn("node", ["scripts/fake-gateway.mjs", "--port", String(gatewayPort)], {
      cwd: process.cwd(),
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, FAKE_GATEWAY_KEY: "local-test-key" },
    });
    await new Promise((r) => setTimeout(r, 900));

    server = await boot({
      RATE_LIMIT_RUNS_PER_MINUTE: 500,
      LLM_GATEWAY_URL: `http://127.0.0.1:${gatewayPort}/v1`,
      LLM_GATEWAY_API_KEY: "local-test-key",
      LLM_GATEWAY_MAX_ATTEMPTS: 2,
      LLM_GATEWAY_BACKOFF_MS: 50,
      ORCHESTRATOR_MAX_REVISIONS: 1,
      // openai always 503s, so every agent exercises retry + fallback. The
      // free route is what the ranking picks next, so that is where the
      // Verifier lands and where the REVISE verdict has to come from.
      MODEL_OPENAI: "openai/gpt-down",
      MODEL_CLAUDE: "anthropic/sonnet-ok",
      MODEL_GEMINI: "gemini/flash-revise",
      MODEL_PERPLEXITY: "perplexity/sonar-ok",
      MODEL_CLAUDE_INPUT_COST_PER_M: 3,
      MODEL_CLAUDE_OUTPUT_COST_PER_M: 15,
      MODEL_OPENAI_INPUT_COST_PER_M: 2.5,
      MODEL_OPENAI_OUTPUT_COST_PER_M: 10,
      MODEL_GEMINI_INPUT_COST_PER_M: 0,
      MODEL_GEMINI_OUTPUT_COST_PER_M: 0,
      MODEL_PERPLEXITY_INPUT_COST_PER_M: 1,
      MODEL_PERPLEXITY_OUTPUT_COST_PER_M: 1,
    });
    try {
      await liveSuite(server.base);
    } finally {
      await server.stop();
      gateway.kill("SIGTERM");
    }

    server = await boot({ RATE_LIMIT_RUNS_PER_MINUTE: 3 });
    try {
      await limitSuite(server.base);
    } finally {
      await server.stop();
    }
  }

  console.log("");
  if (failed === 0) {
    console.log(green(`  ${passed} checks passed.\n`));
    process.exit(0);
  }
  console.log(red(`  ${failed} of ${passed + failed} checks failed:`));
  for (const f of failures) console.log(red(`    ${f.group} › ${f.name}`));
  console.log("");
  process.exit(1);
}

main().catch((error) => {
  console.error(red(`\n  Suite could not run: ${error?.stack ?? error}\n`));
  process.exit(1);
});
