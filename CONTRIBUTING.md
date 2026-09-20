# Contributing

Thanks for taking an interest. This project is small and deliberately
opinionated, so the fastest route to a merged change is a short issue first
describing the problem you hit.

## Getting set up

```sh
npm run install:ci     # one locked install
cp .env.example .env    # placeholders are fine; the app runs without a gateway
npm run dev             # http://localhost:5173
```

No gateway, no database and no API key are needed to develop. With nothing
configured the app runs its routing preview, which emits exactly the same event
stream as a live run — so the interface is never faking anything.

## Before you open a pull request

```sh
npm run verify      # types, lint, 97 unit tests
npm run verify:all  # the above, plus a build and 53 end-to-end checks
```

`verify:all` boots the built Worker and asserts against real HTTP, including a
live-gateway phase backed by `scripts/fake-gateway.mjs`. It needs no network and
no credentials.

## House rules

**Every behaviour change needs a test that fails without it.** The suites are
fast and have no external dependencies, so there is no excuse to skip this.
`docs/HARDENING.md` records what each existing test is protecting — read the
entry before changing the behaviour it covers.

**Keep decisions pure and testable.** Request shape, limits, classification and
routing are pure functions in `lib/`; the route handlers sequence them and do
no deciding of their own. Resist putting a rule in a handler.

**Provider preferences live in data, not in code.** Capability scores, tiers,
prices and context windows are environment values. A change like "prefer X for
coding" is configuration — if you find yourself writing `provider === "..."` in
the ranking logic, that is the smell.

**Never claim work that did not happen.** The Inbox Agent says plainly that it
cannot read email without a bridge; token counts are flagged `estimated` when a
provider omits usage; approvals record a decision and execute nothing. Keep
that honesty — it is the point of the project, not a limitation of it.

**No personal data in the repository.** The owner name is the `OWNER_NAME`
environment variable. Don't hardcode names, emails, account identifiers or
machine paths, in code or in tests.

## Adding a model provider

1. Add it to `allProviders` and the default tables in `lib/model-router.ts`
   (strengths, tier, context window).
2. Add its `MODEL_<NAME>_*` variables to `.env.example`.
3. Add it to the provider list in the dashboard and to `scripts/doctor.mjs`.
4. Add a routing test proving it is chosen for the work it is good at.

## Commit style

Explain why in the body, not just what. A one-line subject in the imperative —
"Fix retry events arriving after the call they describe" — is ideal.
