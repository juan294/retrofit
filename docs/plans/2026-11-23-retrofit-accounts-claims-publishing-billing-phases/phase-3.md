# Phase 3: ownership claims

Parent plan: [2026-11-23-retrofit-accounts-claims-publishing-billing.md](../2026-11-23-retrofit-accounts-claims-publishing-billing.md).

## Entry conditions

- Phase 2 accepted (or continuation authorized). Rebase on current `develop`.

## Changes

```
@ verifyClaim(claim) -> {status, checked, found}
ctx: guardedFetch (robots, pacing, SSRF guard), node:dns resolveTxt, AccountData, clock
pre: claim belongs to the signed-in account; host is a validated host
do:
  1. lookup the token hash and method
  2. br meta: fetch https://<host>/ with guardedFetch; parse <head> meta[name=retrofit-site-verification]
  3. br dns: resolveTxt(_retrofit-verification.<host>); match retrofit-site-verification=<token>
  4. compute match against the stored hash (constant time)
  5. write status, verified_at or failures, last_checked_at
br: robots blocks RetrofitBot -> status pending, reason robots_blocked (DNS hint)
fx: claim row update; a verified claim held by another account moves to this account
fail: fetch or DNS error -> pending with the error kind, never verified
```

- `src/lib/claims/*`: create (token shown once, hash stored), verify, recheck; `src/app/api/claims/*` routes (same-origin, signed-in).
- Account page: "Claim a site" from a saved report or a recent analysis; per-claim panel with the exact tag or record to add, "Check again", status, last check and reason.
- `src/app/api/cron/claims/route.ts` (Bearer `CRON_SECRET`, like the existing crons): rechecks verified claims older than 24 hours, at most 50 per run, paced per host; three consecutive failures set `lapsed`; `vercel.json` gains the cron.
- Claim limits: 10 pending claims per account, 5 checks per claim per hour.

## Tests (TDD, red first)

- `tests/claims/verify.test.ts`: meta found in `<head>`, not in `<body>`; a meta in a comment or with another name is ignored; DNS with several TXT strings and split records; wrong token; robots-blocked fixture gives `robots_blocked`; fetch timeout stays pending.
- `tests/claims/recheck.test.ts`: three failures lapse; one pass restores; the cron refuses without the Bearer secret; the per-run cap holds.
- `tests/claims/transfer.test.ts`: a second account's verification moves the host and records the change; the first account sees "Ownership moved to another account on <date>".
- `e2e/claims.spec.ts`: claim the bakery fixture by meta (the fixture server serves the tag for the test token), see verified; DNS path with the fake resolver in fixtures mode.

## Exit criteria

- Parent success criterion 4 passes.
- Full gate, analyzer ACCEPTED, required tests updated.
- Review, repair, simplify, handoff. Stop for acceptance.
