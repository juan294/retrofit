# Phase 1: data foundation, pricing with notify me, privacy and terms

Parent plan: [2026-11-23-retrofit-accounts-claims-publishing-billing.md](../2026-11-23-retrofit-accounts-claims-publishing-billing.md). Read its Design, Success criteria and Stuck states first.

## Entry conditions

- Owner accepted the plan.
- Worktree from current `develop`; base commit, specification HEAD and the open UI-pass commits recorded in the notes file (created now).

## Changes

### Unit A `[batch-eligible]`: migration and `AccountData`

Files: `supabase/migrations/20261123120000_accounts.sql`, `src/lib/accounts/data.ts` (interface), `src/lib/accounts/memory.ts`, `src/lib/accounts/supabase.ts`, `tests/accounts/data-contract.ts` (shared suite), `tests/accounts/data.memory.test.ts`, `tests/db/accounts.db.test.ts`.

- All eight tables of the parent plan, RLS on with no policies, `grant` to `service_role` only, `revoke` from `anon` and `authenticated`; foreign keys to `auth.users(id) on delete cascade` where an account owns the row.
- `AccountData` methods in this phase: `addNotifySignup(email, consent)`, `unsubscribe(tokenHash)`; later phases add their own methods with contract tests.
- Database tests: the migration applies after `supabase db reset` on the gate stack; the `anon` key gets "permission denied" on every new table (the probe the store tables use).

### Unit B `[batch-eligible]`: pages

Files: `src/app/pricing/page.tsx`, `src/app/privacy/page.tsx`, `src/app/terms/page.tsx`, `src/lib/billing/plans.ts` (plan names and features; no amounts), `src/lib/site/legal-texts.ts`, `src/components/NotifyForm.tsx`.

- `/pricing`: the plans table from `plans.ts`, "Free during the hackathon judging period" note until `BILLING_START`, and the notify form (email, unticked "Send me product news" checkbox, privacy link).
- `/privacy` and `/terms`: drafts written from what the code stores (visitor and account cookies, analyses and their retention, notify signups, claims, published pages, Stripe customer ids) and what it sends (crawls with RetrofitBot, model calls to the visitor's provider or Otari, mail through SES). Marked for owner review.

### Integration (one owner)

- `POST /api/notify` (`src/app/api/notify/route.ts`): same-origin only, body under 2 KB, email syntax check, per-network window (5 an hour), always the same 200 answer; `GET /unsubscribe?t=<token>` confirms and records `unsubscribed_at`.
- `OWN_PAGES`, `sitemap.ts`, `robots.ts`, `llms.txt`: add `/pricing`, `/privacy`, `/terms`; `tools/release/production-evidence.mjs` page list updated.
- Home page footer links to the three pages.

## Tests (TDD, red first)

- Contract suite for notify signups (lower-casing, duplicate, consent default false, unsubscribe once and again).
- `tests/api/notify.test.ts`: cross-origin 403, oversize 413, invalid email 400, limit 429 with `retryAt`, same 200 for new and repeat signups.
- `e2e/pricing.spec.ts`: form posts, the checkbox starts unticked, the privacy link is present, the confirmation text shows; phone width and both color schemes.
- `tests/site/own-site.test.ts`: the new pages in sitemap, `llms.txt` and robots.

## Exit criteria

- Parent success criteria 1 and 2 pass; 9 for the new pages.
- Full gate on the phase head, analyzer ACCEPTED, new tests in `tools/release/required-tests.json`.
- Review, repair, simplify, handoff in the notes file. Stop for acceptance. Owner manual check 1 (privacy and terms) is required before any release that includes this phase.
