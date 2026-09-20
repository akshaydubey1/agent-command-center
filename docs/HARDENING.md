# Hardening review

A review pass across engineering, architecture and test. Every finding below was
reproduced, fixed, and covered by a test that fails without the fix.

## Findings

### 1. The event stream lied about retries — *high*

**Symptom.** `agent.retry` reached the browser only after the call it described
had already finished. A run could sit visibly idle for 45 seconds during a
retry-with-backoff and then jump straight to "complete".

**Cause.** The orchestrator buffered events in an array and flushed them between
agent calls, so anything emitted *during* a call waited for that call to return.

**Fix.** The orchestrator now drives an async queue: the pipeline runs as its own
task and pushes events the moment they occur, while the generator yields them as
they arrive. A caller that stops reading (client disconnect) closes the queue and
the pipeline is awaited rather than left running unobserved.

**Test.** `tests/orchestrator.test.ts` — "streams a retry while the call is still
retrying" holds the second attempt open with a gate and asserts the retry event
is in hand while the call is still outstanding.

### 2. Anonymous visitors shared one tenant — *high*

**Symptom.** Every signed-out visitor was stored under the owner id
`"anonymous"`, so on a public deployment one visitor could list and open another
visitor's runs, including their prompts.

**Fix.** Identity now carries `persistable`. Anonymous identities are never
persistable: their runs stay in their own browser, `/api/runs` returns an empty
durable-false list, run detail returns 404, and approval decisions are recorded
locally only. Durable history is a signed-in feature by design, not by accident.

**Test.** `tests/mission-contract.test.ts` (tenancy) plus four end-to-end checks
that assert user B cannot see or decide on user A's run.

### 3. One rate-limit bucket for every anonymous caller — *medium*

**Symptom.** The limiter keyed on `identity.userId`, which is the same string for
all anonymous callers, so a single visitor could exhaust the allowance for
everyone.

**Fix.** `rateLimitKey()` buckets signed-in callers per account and anonymous
callers per client address (`cf-connecting-ip`, else the first `x-forwarded-for`
hop).

**Test.** Unit tests for key derivation; an end-to-end check that a second caller
is unaffected once the first is refused.

### 4. SSE had no disconnect or idle handling — *medium*

**Symptom.** `controller.enqueue()` throws once the client is gone, which
surfaced as an unhandled rejection; and a long gateway call could leave the
connection silent long enough for an intermediary to drop it.

**Fix.** Every write is guarded and a failed write ends the stream cleanly; a
15-second `: keep-alive` comment keeps the connection warm; the stream always
terminates with `[DONE]` and closes exactly once.

### 5. Re-persisting a run duplicated its steps — *low*

**Symptom.** `runs` used `onConflictDoNothing`, but `agent_steps` did not, so
storing the same run twice appended a second full set of step rows.

**Fix.** The insert returns the row it created; when nothing was created the run
is already on file and its steps and approvals are left alone.

### 6. Validation lived in the route and was untestable — *low*

**Fix.** All request-shape decisions moved to `lib/mission-contract.ts` as pure
functions: body shape, prompt bounds, body-size cap (64 KB), enum cleaning,
provider de-duplication, and stream negotiation. The route sequences; it no
longer decides. 22 unit tests cover the contract, including the boundary at
exactly `MAX_PROMPT_LENGTH` and the rule that a bad enum must never fail a run.

### 7. No way to answer "is this actually connected?" — *medium*

**Fix.** `npm run doctor` reads `.env`, then makes one real minimal call per
configured route and prints, per provider: connected with latency, tokens and
cost, or the exact reason it is not — a rejected key, an unknown model id, a
timeout, a disabled flag, or simply not configured. It exits non-zero when no
route answers, so it works in CI.

## What the tests cover

| Layer | Where | Count |
| --- | --- | --- |
| Classifier, routing, cost | `tests/model-router.test.ts` | 28 |
| Gateway: retries, backoff, fallback, timeout, cancellation | `tests/gateway.test.ts` | 17 |
| Orchestrator: event order, revision loop, cancellation, preview parity | `tests/orchestrator.test.ts` | 17 |
| Request contract, tenancy, limit keys | `tests/mission-contract.test.ts` | 22 |
| Identity and rate limiting | `tests/access.test.ts` | 13 |
| **Unit total** | `npm test` | **97** |
| HTTP surface, persistence, isolation, limits, live path | `npm run test:e2e` | **53** |

The end-to-end suite boots the built Worker and asserts against real HTTP. It
runs in three phases on separate ports: functional, live-gateway, and rate
limiting (a 3-per-minute server, so the refusal is real rather than simulated).
Each boot verifies it is talking to its own server before testing — an earlier
version of the harness silently reused the previous phase's server and reported
a false pass.

## Testing the live path without spending money

`npm run gateway:fake` starts a stand-in gateway that speaks the
OpenAI-compatible shape. Model-id suffixes drive its behaviour — `ok`, `slow`,
`429`, `down`, `401`, `revise` — so the real failure paths can be exercised on
demand:

```sh
npm run gateway:fake &
LLM_GATEWAY_URL=http://127.0.0.1:5399/v1 \
LLM_GATEWAY_API_KEY=local-test-key \
MODEL_OPENAI=openai/gpt-down \
MODEL_GEMINI=gemini/flash-revise \
npm run doctor
```

The end-to-end suite uses it to prove, against real HTTP: retry with backoff on
a refusing provider, fallback to the next ranked route with the reason recorded,
token counts taken from the provider response, cost computed from configured
prices, the Verifier returning `REVISE` and the Builder re-running, and the whole
run stored with its usage intact.

## Known limits, stated plainly

- **The per-minute limiter is per isolate.** Worker isolates are per-colo and
  short-lived, so it is burst protection. The durable control is
  `RATE_LIMIT_RUNS_PER_DAY`, counted in D1.
- **Approvals authorise, they do not execute.** Approving records an audit row.
  Nothing in this workspace sends, deploys, charges or deletes.
- **Inbox Agent cannot read email** in an independently hosted deployment until
  an OAuth or MCP bridge exists. The preview output says so rather than implying
  a message was read.
- **Token counts are estimated** when a provider omits `usage`; the result is
  flagged `estimated: true` rather than presented as measured.
