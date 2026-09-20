# Security

## Reporting a vulnerability

Open a private security advisory on the repository rather than a public issue.
Include what you did, what happened, and what you expected. You will get an
acknowledgement; there is no bounty programme.

## What this project does with credentials

- **It never handles provider API keys in the browser.** The dashboard calls
  this app's own API; the app calls one OpenAI-compatible gateway server-side.
  The key lives in `LLM_GATEWAY_API_KEY` as a deployment secret.
- **`.env` is git-ignored** and `.env.example` contains only placeholders.
  Nothing in the repository is a real credential; the `local-test-key` in the
  test suite belongs to the stand-in gateway that runs on localhost.
- **`/api/status` never returns a key**, and withholds model identifiers from
  anonymous visitors.

## Before you deploy publicly

A mission can trigger up to six model calls, so an open endpoint is a direct
line to your gateway bill. At minimum:

| Setting | Why |
| --- | --- |
| `REQUIRE_SIGNED_IN=true` | Refuse anonymous runs entirely. |
| `RATE_LIMIT_RUNS_PER_DAY` | The durable cap, counted in the database. Set it to a number you are willing to pay for. |
| `RATE_LIMIT_RUNS_PER_MINUTE` | Burst protection. It lives in the worker isolate, so treat it as best-effort. |
| `MISSION_API_TOKEN` | Only if scripted callers need access; sent as `x-mission-token`. |

## Tenancy

Stored runs are owned by the authenticated user id. Anonymous visitors are
never `persistable`: their runs stay in their own browser and never reach the
shared database, because every anonymous visitor would otherwise share a single
owner id and be able to read the others' prompts. If you replace the identity
layer, preserve that property — `lib/identity.ts` and the tenancy tests in
`tests/mission-contract.test.ts` and `scripts/e2e.mjs` are where it is enforced.

## What the agents can and cannot do

The workspace prepares work; it does not act. Approving an item in the queue
records an audit decision — it sends no email, deploys nothing, spends nothing.
If you extend this project to execute approved actions, that execution path is
new attack surface and needs its own review: treat model output as untrusted
input, and never let a model choose the recipient of an irreversible action.
