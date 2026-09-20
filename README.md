# Agent Command Center

A supervised four-agent workspace. You give it an outcome; it decides which
agents the request is actually worth, routes each one to the cheapest capable
model, has its own work reviewed before you see it, and holds every external
action behind an approval queue.

Runs on [vinext](https://github.com/cloudflare/vinext) as a Cloudflare Worker,
with D1 and Drizzle for storage. MIT licensed — take it, change it, ship it.

```sh
git clone <your fork>
cd agent-command-center
npm run install:ci
npm run dev            # http://localhost:5173
```

**No API key, no database and no account are needed to try it.** With nothing
configured, missions run a deterministic routing preview that emits exactly the
same event stream as a live run — the classification, the agent decisions, the
token budgets and the approval queue are all real. Only the agent text is
stand-in, and the interface says so.

## Why it exists

Most multi-agent demos run every agent on every request and bill you for the
privilege. This one starts from the opposite question: *what does this request
actually need?*

Ask it to fix a sentence and it wakes **one** agent on a free-tier model, about
270 tokens. Ask it to send a renewal email and deploy to production and it wakes
**all four**, adds an independent review pass, and puts two named,
high-risk items in the approval queue before anything leaves the building —
about 3,300 tokens. Same system, 12× the cost difference, decided from your
wording.

## The four agents

| Agent | Role |
| --- | --- |
| **Inbox** | Reads connected mail, finds commitments and deadlines, drafts replies. Never sends. |
| **Builder** | Does the work. Re-does it when the Verifier sends corrections. |
| **Verifier** | Reviews adversarially. Answers `VERDICT: PASS` or `VERDICT: REVISE` with numbered corrections. |
| **Chief** | Plans, delegates, reconciles, and assembles the approval-ready package. |

A `REVISE` verdict genuinely sends the work back: the Builder revises, the
Verifier re-checks, and the run records how many rounds it took.

## What's in the box

- **Auto Router** — scores each request across nine signals, activates only the
  agents it needs, caps every agent's output tokens, drops models whose context
  window can't hold the request, and ranks the rest on capability and price.
  A short reply that happens to mention a doctor or a contract is *not*
  escalated into a high-stakes run.
- **Streaming execution** — `POST /api/mission` returns Server-Sent Events, so
  each agent appears as it starts, retries, revises and finishes. Cancelling
  aborts the in-flight provider calls.
- **Resilient calls** — hard timeouts, exponential backoff honouring
  `Retry-After`, and an ordered fallback chain per agent. A non-retryable
  failure skips straight to the next provider instead of burning the budget.
- **Real cost accounting** — token usage read from the provider response, costs
  computed from your configured prices, totals stored per run.
- **Durable history and approvals** in D1, scoped per user, degrading to
  browser-local storage when no database is bound.
- **Access control** — optional required sign-in, an optional service token, a
  per-minute burst limiter and a durable daily cap.

## Is it connected?

```sh
npm run doctor
```

Makes one real minimal call per configured route and reports the truth:

```
  connected    OpenAI       openai/gpt-4.1     412 ms · 5+14 tok · $0.000152
  failed       Gemini       gemini/flash       HTTP 404 (the gateway does not know this model id)
  not set      Claude       MODEL_CLAUDE is not set.
```

Exits non-zero when nothing answers, so it works in CI.

## Trying the live path without spending anything

```sh
npm run gateway:fake
```

A stand-in gateway speaking the OpenAI-compatible shape. Model-id suffixes drive
its behaviour — `ok`, `slow`, `429`, `down`, `401`, `revise` — so you can force
retries, provider fallback and the revision loop on demand. The end-to-end suite
uses it to prove all of those over real HTTP.

## Configuration

Copy `.env.example` to `.env`. Everything is optional; the app degrades honestly
without each piece.

| Variable | Purpose |
| --- | --- |
| `OWNER_NAME` | Who the workspace belongs to. Shown in the UI, given to the agents. |
| `LLM_GATEWAY_URL`, `LLM_GATEWAY_API_KEY` | Your OpenAI-compatible gateway (LiteLLM works well). |
| `MODEL_<PROVIDER>` | The exact model id for each route. |
| `MODEL_<PROVIDER>_TIER`, `_INPUT_COST_PER_M`, `_OUTPUT_COST_PER_M` | Cost data the router ranks on. |
| `MODEL_<PROVIDER>_CONTEXT`, `_STRENGTHS` | Context window and capability scores, 0–10. |
| `REQUIRE_SIGNED_IN`, `MISSION_API_TOKEN` | Who may run a mission. |
| `RATE_LIMIT_RUNS_PER_MINUTE`, `_PER_DAY` | Burst and durable spend caps. |

Provider preference is **data, not code** — adding or re-ranking a model is a
configuration change. Read [`SECURITY.md`](SECURITY.md) before deploying this
anywhere public: an open endpoint is a direct line to your gateway bill.

## Verifying

```sh
npm run verify      # types, lint, 97 unit tests — no network, no build
npm run verify:all  # the above, plus a build and 53 end-to-end checks
```

The end-to-end suite boots the built Worker and asserts over real HTTP in three
phases: functional, live-gateway, and rate limiting against a genuinely
limited server. [`docs/HARDENING.md`](docs/HARDENING.md) records every defect
found in review, its fix, and the test that now protects it.

## Project layout

| Path | Purpose |
| --- | --- |
| `lib/model-router.ts` | Classification, agent activation, token budgets, ranking, cost projection. |
| `lib/gateway.ts` | Timeouts, retries, fallback chain, usage and cost extraction. |
| `lib/orchestrator.ts` | The four-agent workflow as a typed event stream, including the revision loop. |
| `lib/mission-contract.ts` | Request shape, bounds and limits as pure functions. |
| `lib/identity.ts`, `lib/rate-limit.ts` | Who is calling, and how often they may. |
| `lib/run-store.ts`, `db/schema.ts` | D1 persistence for runs, agent steps and approvals. |
| `app/agent-command-center.tsx` | The dashboard, driven entirely by the event stream. |
| `scripts/doctor.mjs` | Per-route connectivity check. |
| `scripts/fake-gateway.mjs` | Stand-in provider for offline testing. |
| `scripts/e2e.mjs` | End-to-end checks against the built Worker. |
| `tests/` | 97 unit tests across router, gateway, orchestrator, contract and access. |

## Honest limits

- **Approvals authorise; they do not execute.** Approving records an audit row.
  Nothing here sends, deploys, charges or deletes.
- **The Inbox Agent cannot read email** without an OAuth or MCP bridge, and it
  says so rather than pretending otherwise.
- **The per-minute limiter is per worker isolate** — burst protection. The daily
  cap is the durable one.
- **Token counts are estimated** when a provider omits usage, and flagged as such.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). Every behaviour change needs a test
that fails without it; the suites are fast and need no credentials.

## Credit

Created by Akshay Dubey. Licensed under the [MIT License](LICENSE).

---

## Platform notes

The remainder of this document covers the hosting platform this site is
deployed on.

## Prerequisites

- Node.js `>=22.13.0`
- Portable: Windows, macOS, or Linux; no Bash required
- Managed Linux: managed Linux runtime with Bash, `flock`, `curl`, `sha256sum`, and GNU `timeout`
- Git is required only for publishing

## Sites Lifecycle

The Sites initializer copies the shared starter and selects managed-linux only when `SITES_MANAGED_LINUX_CONTAINER=1`; otherwise it selects portable. It saves the selection only in ignored `.sites-runtime/execution-profile.json`. Both profiles copy/configure first, then use the plugin's separate `install-dependencies.mjs` step to measure installation independently. Edit source under `app/` and follow the Sites skill for installation, preview, builds, and publishing.

Whenever reopening or moving a checkout, run `node <plugin-root>/scripts/configure-execution-profile.mjs` before project commands. Profile changes do not alter tracked source or require reinstalling otherwise-valid dependencies; restart an existing preview to use the new selection. Do not commit or upload `.sites-runtime/`.

This starter does not use `wrangler.jsonc`.

`install:ci` runs `npm ci` once against the shared lockfile, disables parent-workspace discovery, and includes required dev/optional dependencies despite production/omit settings. Sharp defaults to prebuilt binaries unless explicitly configured otherwise. Do not overlap installers.

- **Portable:** Preserve host HOME, npm cache, registry, proxy, temporary paths, retry/concurrency settings, and lifecycle-script policy. Use `--prefer-offline --no-audit --no-fund`.
- **Managed Linux:** Use the existing project-local HOME/cache/tmp setup and Linux install lock, tarball preflight, and timeout. Restore the image-seeded npm cache only when its lockfile hash matches; retain network fallback. Builds keep their existing timeout. These helpers are not invoked by the portable profile.

`scripts/sites-env.mjs` preserves the caller's HOME, npm cache, proxy, XDG, and temporary-directory configuration while defaulting Wrangler and Miniflare state to the checkout. If npm reports an unwritable cache, select a writable path with `npm_config_cache` for that install. The `dev` and `start` scripts also keep Wrangler logs inside the checkout. Generated `.sites-runtime/` and `.wrangler/` directories are disposable and ignored by Git.

On portable, `npm run dev` uses `vinext dev` with HMR, starting at port 5173. Vinext records the running server in ignored `.vinext/` state, rejects an ordinary duplicate launch, and recovers stale state after a stopped process; exactly simultaneous starts can race. Pass `--port <port>` or `--hostname <host>` after `npm run dev --` when needed; keep portable previews on loopback.

For browser QA on managed Linux, use `sites-preview start`. The project's dev script runs Vite and accepts the supervisor's `--host 0.0.0.0 --port 4173 --strictPort` arguments. The internal browser uses `http://terminal.local:4173/`; it is not a user-facing URL. The supervisor owns the preview lifecycle. The ignored local profile survives the supervisor's cleared process environment.

The portable profile simulates ChatGPT sign-in only for loopback development requests. Visit `/signin-with-chatgpt?return_to=/` to sign in as `local_seedy` (`seedy@sites.test`, display name `Seedy`) and `/signout-with-chatgpt?return_to=/` to sign out. The development cookie preserves that identity across server restarts. Mock auth is disabled in the managed-linux profile and is not included in production builds; hosted authentication remains dispatch-owned.

The Worker uses `vinext/server/fetch-handler`, including Vinext's config-aware image handling. After building, `npm start` runs that Worker locally through Wrangler on `127.0.0.1`, sharing `.wrangler/state` with dev preview and local D1 migrations; it does not deploy the site or simulate sign-in. Use the URL printed by the server. Pass `npm start -- --port <port>` to select a different built-preview port.

Local previews use Miniflare's placeholder `Request.cf` metadata without a network lookup. Set `CLOUDFLARE_CF_FETCH_ENABLED=true` to opt into fetching preview metadata; this setting does not change hosted request metadata.

Local tool usage metrics are disabled by default. Set `WRANGLER_SEND_METRICS=true` to opt in.

## Included Shape

- edit site code under `app/`
- `app/chatgpt-auth.ts` provides optional dispatch-owned ChatGPT sign-in helpers
- `.openai/hosting.json` declares optional Sites D1 and R2 bindings
- `vite.config.ts` simulates declared bindings for local development
- `db/index.ts` reads the D1 binding from the Cloudflare Worker environment
- `db/schema.ts` defines the `runs`, `agent_steps`, and `approvals` tables
- `@cloudflare/workers-types` provides Worker types; `cloudflare-env.d.ts` declares optional `DB`/`BUCKET` bindings—update these declarations if binding names change
- `examples/d1/` contains an optional D1 example surface
- `.openai/hosting.json` sets `d1` to `DB`, the binding the run store expects
- `drizzle.config.ts` supports local migration generation when needed

## Workspace Auth Headers

Signed-in visitors receive both `oai-authenticated-user-id` and `oai-authenticated-user-email`. Private Sites require every visitor to sign in; public Sites may also have anonymous visitors, for whom neither header is present.

The user ID is stable for the same user on the same Site and different across Sites. Use it as the durable user key; use email and name for display or contact purposes.

SIWC-authenticated workspace sites may also receive `oai-authenticated-user-full-name` when the user's SIWC profile has a non-empty `name` claim. The full-name value is percent-encoded UTF-8 and is accompanied by `oai-authenticated-user-full-name-encoding: percent-encoded-utf-8`.

Treat the full name as optional and fall back to email when it is absent:

```tsx
import { headers } from "next/headers";

export default async function Home() {
  const requestHeaders = await headers();
  const userId = requestHeaders.get("oai-authenticated-user-id");
  const email = requestHeaders.get("oai-authenticated-user-email");
  const encodedFullName = requestHeaders.get("oai-authenticated-user-full-name");
  const fullName =
    encodedFullName &&
    requestHeaders.get("oai-authenticated-user-full-name-encoding") ===
      "percent-encoded-utf-8"
      ? decodeURIComponent(encodedFullName)
      : null;

  const displayName = fullName ?? email;
  // ...
}
```

## Optional Dispatch-Owned ChatGPT Sign-In

Import the ready-to-use helpers from `app/chatgpt-auth.ts` when the site needs optional or required ChatGPT sign-in:

- Use `getChatGPTUser()` for optional signed-in UI.
- Use the returned `userId` as the stable user key for user-owned records; do not use email as a durable identifier.
- Use `requireChatGPTUser(returnTo)` for server-rendered pages that should send anonymous visitors through Sign in with ChatGPT.
- In a Server Component, start sign-in with `<a href={chatGPTSignInPath(returnTo)} target="_top">`. The auth helper module is server-only; do not import it into a Client Component.
- Do not use `fetch`, XHR, a client-side router, or a framework link that can prefetch the sign-in route. SIWC must start as a top-level navigation.
- Never request the AuthAPI authorization endpoint directly. The dispatch-owned `/signin-with-chatgpt` route must start the SIWC flow.
- Use `chatGPTSignOutPath(returnTo)` for browser sign-out links or actions.
- Pass a same-origin relative `returnTo` path for the destination after sign-in or sign-out. The helper validates and safely encodes it.
- Mark protected pages with `export const dynamic = "force-dynamic"` because they depend on per-request identity headers.

Dispatch owns `/signin-with-chatgpt`, `/signout-with-chatgpt`, `/callback`, the OAuth cookies, and identity header injection. Do not implement app routes for those reserved paths. Routes that do not import and call the helper remain anonymous-compatible.

SIWC establishes identity only; it does not prove workspace membership. Use the Sites hosting platform's access policy controls for workspace-wide restrictions, or enforce explicit server-side membership or allowlist checks.

Use SIWC for account pages, user-specific dashboards, saved records, and write actions tied to the current ChatGPT user. Leave public content anonymous.

## Local D1 migrations

For a D1-backed local preview, generate SQL with `npm run db:generate`. Build once through the Sites skill's build entrypoint (or `npm run build` for standalone use) to generate `dist/server/wrangler.json`, rebuilding if bindings change. From the project root, apply each pending migration in order:

```sh
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0000_command_center.sql
```

Replace the filename with the pending migration (this project ships `0000_command_center.sql`) and `DB` with your D1 binding name if different. Use `.wrangler/state`, not `.wrangler/state/v3`; Wrangler adds the versioned directories. Do not replay migrations already applied locally. This updates only the preview database; publishing applies production migrations separately.

## Diagnostic Commands

- `npm run install:ci`: perform the one locked dependency install
- `npm run dev`: start the Vite/Vinext development server
- `npm run build`: build the deployable Sites artifact
- `npm run start`: preview the built Worker locally with D1/R2 support
- `npm run db:generate`: generate Drizzle migrations after schema changes

When using the Sites plugin, follow its skill instructions for installation, builds, and publishing. These npm commands remain available for standalone use.

The portable build runs Vinext directly without a host `timeout` command. The managed-linux build uses `scripts/build-verified.sh` and its existing `SITES_BUILD_TIMEOUT` setting.

## Learn More

- [vinext Documentation](https://github.com/cloudflare/vinext)
- [Drizzle D1 Guide](https://orm.drizzle.team/docs/get-started/d1-new)
