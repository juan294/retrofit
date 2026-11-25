# Plan: accounts, ownership claims, publishing, the badge and billing

> Created 2026-11-23 with `rpi-plan`. Status: all five phases implemented locally on 2026-11-23 (Juan authorized all phases); not released. Deviations and receipts are in the notes file. Phase files: [phase-1](2026-11-23-retrofit-accounts-claims-publishing-billing-phases/phase-1.md) to [phase-5](2026-11-23-retrofit-accounts-claims-publishing-billing-phases/phase-5.md). Notes file (created at Phase 1 entry): `2026-11-23-retrofit-accounts-claims-publishing-billing-notes.md`.

## Objective

Complete the access and usage design of [the brief](../research/2026-11-14-retrofit-brief.md) ("Access rules" and "Usage tiers"): a pricing page with "notify me", accounts, ownership claims, Retrofit-hosted publishing for claimed sites, an embeddable badge, and Stripe billing with paid features. Retrofit stays open and free for everyone, judges included, until 2027-01-18; billing and the free-analysis limit start only after that date.

## Owner decisions (2026-11-23)

| Decision | Answer | Effect on the plan |
| --- | --- | --- |
| Sign-in | Email link through Supabase Auth | Supabase Auth verifies the email; Retrofit then issues its own HttpOnly session cookie, as it does for the free-AI session. Mail goes through AWS SES on `thecreativetoken.com` as Supabase's custom SMTP. No password is stored. |
| Free-analysis limit | Only after 2027-01-18 | The limit is built and tested now behind `BILLING_START`; before that instant nothing changes for visitors or judges. |
| AI for published agents | Visitors bring their own key | A published agent uses the same BYOK router default as the installed bundle (`target: "bundle"` in `src/lib/generate/network.ts`). No Retrofit free AI for published pages; no new cost. |
| Prices | Decide later | Stripe products and prices are configuration. The pricing page shows plans and features; it shows an amount only when the price is configured, and "notify me" until billing starts. |

Kept from earlier decisions: anyone can analyze any URL and get a private, unofficial preview without a claim (brief, Access rules); the analysis owner downloads the install bundle without a claim ([2026-11-22 decision](../decisions/2026-11-22-bundle-without-claim.md)); a claim is required for Retrofit-hosted publishing and the badge (`AGENTS.md`, Product and data constraints); a visitor's LLM key never reaches Retrofit's servers.

## Current state (verified 2026-11-23 on `develop` `e93c3d6`; production `v0.2.0` at `7aa6eb1`)

- Data: one key-value `Store` with expiry (`src/lib/store/types.ts:19`), memory and Supabase adapters, and two migrations (`supabase/migrations/20261115120000_store.sql`, `20261115130000_claim_with_lease.sql`). The Supabase tables are reachable only with the service role.
- Identity: anonymous visitors. `retrofit_visitor` is a 128-bit random cookie; the store keeps its SHA-256 (`src/lib/analysis/visitor.ts`). Analyses live 24 hours plus a 7-day grace (`src/lib/analysis/record.ts:45`). Free-AI sessions use a signed `retrofit_session` cookie (`src/lib/inference/session.ts:48`).
- Limits: anonymous per network: analyses per hour (`countClientAnalysis`, `src/lib/fetch/limits.ts:61`), a daily cap per site, free-AI session and judge caps.
- Fetching: `guardedFetch` with robots, pacing, private-path refusal and an SSRF guard that resolves names through `node:dns` (`src/lib/fetch/guard.ts:1-13`).
- Pages: `/`, `/r/<id>`, `/bot`, `/conformance`, `/judges`; previews and their files under `/p/<id>/`. No pricing, privacy, terms, account or sign-in page. The request hook matcher skips `p/<id>/bridge/` (`src/proxy.ts:45`).
- Mail: SES identity `thecreativetoken.com` verified with DKIM; the SES account is in the sandbox (`aws sesv2 get-account`: `ProductionAccessEnabled: false`, quota 200 a day), so it can send only to verified addresses. Inbound `retrofit@thecreativetoken.com` forwards to Juan.
- Dependencies: `@supabase/supabase-js` 2.119.0 is installed; no Stripe package.

## Design

### Data

A new migration adds relational tables, each with row level security on and no policy, reachable only by `service_role` (the pattern of the existing tables). Accounts are Supabase Auth users (`auth.users.id`); Retrofit stores no password.

| Table | Purpose | Key columns |
| --- | --- | --- |
| `notify_signups` | Pricing page "notify me" | email (unique, lower case), `marketing_consent` (default false), `unsubscribe_token_hash`, created_at, unsubscribed_at |
| `account_profiles` | Retrofit-side account data | account_id (auth user), created_at, deleted_at |
| `saved_reports` | Reports an account keeps beyond the 24-hour analysis life | id, account_id, host, report (jsonb, `score/v1`), fetched_at |
| `site_claims` | Ownership claims | id, account_id, host, method (`meta` or `dns`), token_hash, status (`pending`, `verified`, `lapsed`), verified_at, last_checked_at, failures |
| `published_sites` | Retrofit-hosted agents | host (unique), account_id, claim_id, snapshot (jsonb), report (jsonb), published_at, refreshed_at, last_refresh_error |
| `billing_customers` | Stripe link and entitlement | account_id, stripe_customer_id, plan, status, current_period_end |
| `stripe_events` | Webhook idempotency | event_id (unique), type, received_at |
| `api_keys` | Bulk API access | id, account_id, key_hash, created_at, revoked_at |

Server code reaches them through a new `AccountData` interface with a memory adapter and a Supabase adapter, checked by one shared contract suite (unit project on memory, `test:db` on the disposable stack), the same structure as `Store`.

### Accounts and sessions

```
@ signIn(email) -> 200 "check your email" | 429 retryAt | 503 mail_unavailable
ctx: Supabase Auth (anon key, server side), SES as custom SMTP
pre: email syntactically valid; per-network and per-email send limits not exceeded
do:
  1. validate email; count send per network and per email (Store windows)
  2. call auth.signInWithOtp with emailRedirectTo PUBLIC_ORIGIN/auth/confirm
  3. emit the same answer whether or not the address has an account
fail: Supabase send error -> 503 with the lead address as the fallback contact
```

```
@ confirm(token_hash, type) -> 303 to the page the visitor started from
ctx: Supabase Auth verifyOtp, Store (session records)
do:
  1. validate query; verifyOtp (one-time, server side)
  2. write account_profiles row if absent
  3. write session record (Store, 30 days) and set retrofit_account cookie (HttpOnly, SameSite=Lax, Secure)
  4. attach the visitor's open analyses to the account (ownerHash stays; accountId added)
fail: expired or used link -> page "This link has expired" with a send-again form
```

The Supabase access and refresh tokens never reach the browser. Sign-out deletes the session record. Account deletion cancels an active subscription first (Phase 5), deletes claims, published sites, saved reports and API keys, then deletes the auth user.

### Ownership claims

- A claim is for one exact host (the host the analysis scored, for example `www.example.com`). The account page creates a claim and shows a token once; the store keeps its hash.
- Meta method: `<meta name="retrofit-site-verification" content="<token>">` in the home page `<head>`, read with `guardedFetch` (robots rules apply; a site that blocks RetrofitBot is told to use DNS).
- DNS method: TXT record `_retrofit-verification.<host>` with value `retrofit-site-verification=<token>`, read with `node:dns` `resolveTxt`.
- A daily cron rechecks verified claims; three consecutive failures mark the claim `lapsed`, which pauses its published site and badge until a check passes again. Two accounts may hold pending claims for one host; the first to verify wins, and a later verification by another account moves the host and records the change.

### Publishing and the badge

- A verified claim can publish the host's latest analysis owned by the account: the snapshot and report are copied into `published_sites`, so they outlive the 24-hour analysis.
- Public page `/s/<host>`: the report (score, "Fix these first", checks) and the agent, built with `generateNetwork(..., target: "bundle")` (BYOK default router, "<host> assistant" brand, no "unofficial" label), with a line "Published by the verified owner of <host>". Agent files under `/s/<host>/` mirror the preview's file routes (`src/lib/preview/artifacts.ts`) without the owner check; `/s/<host>/bridge/` is excluded from the page CSP like `p/<id>/bridge/` (`src/proxy.ts:45`).
- Refresh: the owner runs a new analysis and publishes it again; the page shows the snapshot date. A failed refresh keeps the previous snapshot.
- Badge: `GET /badge/<host>.svg`, public, cached for one hour, `Access-Control-Allow-Origin: *`, showing "Agent-ready <score>/100 · verified by Retrofit" for a published host and linking (in the embed snippet) to `/s/<host>`. Unpublished, lapsed or unknown hosts get 404. The SVG contains only digits and the fixed text, never page content.
- Published pages appear in `sitemap.xml` and are indexable; unpublishing removes them.

### Billing and paid features

- Plans (names fixed now, amounts later): Free, Pro, Agency. Features by plan are one table in code (`src/lib/billing/plans.ts`) that the pricing page, the entitlement check and the tests read.
- Before `BILLING_START` (2027-01-20T00:00:00Z by the owner decision of 2026-11-25, required on Vercel): every visitor keeps today's open access; every signed-in account has every feature; the pricing page shows features and "notify me".
- From `BILLING_START`: anonymous visitors get 5 free analyses (counted per visitor cookie and per network), then a sign-in prompt; signed-in Free accounts analyze with per-account fetch limits and preview on their own key; Pro and Agency add publishing, saved reports, the free-AI preview and API keys with higher `/api/score` limits.
- Stripe Checkout (hosted, subscription mode) and the Stripe customer portal; card data never reaches Retrofit. The webhook (`/api/billing/webhook`) verifies the signature, records the event id once, and updates `billing_customers`. The account page also reconciles from Stripe on load, so a delayed webhook does not block a paying customer.
- Test mode only in this plan. Switching to live keys is a separate authorized release after 2027-01-18.

### Pricing, privacy and terms pages

- `/pricing`: plans, features and "notify me" (email, an unticked marketing-consent checkbox, a link to `/privacy`). A repeat signup answers "You're on the list" without revealing whether the address was already there. Every message carries an unsubscribe link.
- `/privacy` and `/terms`: drafted from what the code stores and sends, then reviewed by Juan before any release. They are product text, not legal advice; Juan owns the final wording.

## Phases

| Phase | Result | External actions inside it (each needs Juan's authorization) |
| --- | --- | --- |
| [1](2026-11-23-retrofit-accounts-claims-publishing-billing-phases/phase-1.md) | Data foundation (migration, `AccountData`), `/pricing` with notify me, `/privacy`, `/terms`, unsubscribe | Apply the migration to production (with the release) |
| [2](2026-11-23-retrofit-accounts-claims-publishing-billing-phases/phase-2.md) | Accounts: sign-in by email link, account page, saved reports, sign-out, account deletion | SES production access request; SES SMTP credentials; Supabase Auth SMTP, redirect URLs and email template |
| [3](2026-11-23-retrofit-accounts-claims-publishing-billing-phases/phase-3.md) | Ownership claims by meta tag or DNS, daily recheck | none beyond the release |
| [4](2026-11-23-retrofit-accounts-claims-publishing-billing-phases/phase-4.md) | Publishing at `/s/<host>`, refresh, unpublish, the badge and its embed snippet | none beyond the release |
| [5](2026-11-23-retrofit-accounts-claims-publishing-billing-phases/phase-5.md) | Billing in Stripe test mode, entitlements, the post-`BILLING_START` free limit, API keys | Stripe account; test keys; test webhook endpoint; production variables |

Phases run in order with an acceptance stop after each, unless Juan authorizes continuation. Each follows implement, independent review, repair, simplify, full gate (`python3 .rpi/scripts/rpi-verify.py`, then `node tools/release/analyze-evidence.mjs <commit>`). A release is a separate authorized workflow and may bundle several accepted phases.

## Success criteria

Automated (each named test joins `tools/release/required-tests.json`):

1. The `AccountData` contract suite passes on the memory adapter (unit) and on the disposable Supabase stack (`test:db`); the migration applies on a reset stack, and the `anon` role gets "permission denied" on every new table (same probe as the store tables).
2. Notify me: a signup stores a lower-case email with `marketing_consent` false unless the box was ticked; a repeat signup gives the same answer; unsubscribe by token works once and is idempotent; the form is refused without the privacy link present (`e2e/pricing.spec.ts`).
3. Sign-in: with a fake Supabase Auth and mailer, the same answer for known and unknown emails; per-email and per-network send limits; a confirmed link sets `retrofit_account` and attaches the visitor's analyses; an expired link shows the send-again form; no Supabase token appears in any response header or body (`tests/accounts/*.test.ts`, `e2e/account.spec.ts`).
4. Claims: meta and DNS methods verify with fixture sites and a fake resolver; a robots-blocked site gets the DNS hint; three failed rechecks lapse a claim and pause its site and badge; one passing check restores them; a second account's verification moves the host (`tests/claims/*.test.ts`).
5. Publishing: `/s/<host>` serves the report and an agent whose manifest passes `build_network.mjs` (the oracle in `tests/bundle/oracle.test.ts`) with the BYOK router and no Retrofit inference URL; a lapsed or unpublished host returns 404; `check_partner.mjs` accepts a published network on the e2e server (`e2e/publish.spec.ts`).
6. Badge: SVG for a published host with its score; 404 otherwise; the hostile fixture's text never appears in the SVG; `Access-Control-Allow-Origin: *` and a one-hour cache (`tests/badge/*.test.ts`).
7. Billing: entitlement table tests on both sides of `BILLING_START` with the fixtures clock; before it, an anonymous visitor completes 6 analyses and a signed-in account publishes without a plan; after it, the sixth anonymous analysis gets the sign-in prompt and publishing needs Pro; the webhook refuses a bad signature, applies an event once, and the account page reconciles a missed webhook from a fake Stripe (`tests/billing/*.test.ts`, `e2e/billing.spec.ts`).
8. Judges: before `BILLING_START`, the judge path and the free path behave exactly as today (existing `e2e/free-path.spec.ts` and `e2e-prod/judge.spec.ts` unchanged and passing).
9. Phone width (320 px) and both color schemes pass on every new page (`e2e/phone-width.spec.ts`, `e2e/preview-theme.spec.ts` extended).

Manual (owner):

1. Read and approve `/privacy` and `/terms`.
2. Sign in with a real email on production after the SES and Supabase steps, and receive the link.
3. Claim and publish a site you control (for example a `thecreativetoken.com` host) and embed the badge on it.
4. Complete a Stripe test-mode checkout with a Stripe test card and see Pro on the account page.
5. Review the new pages during the UI pass.

## Stuck states and recovery

| State | Who sees it, and what | How it ends | Test |
| --- | --- | --- | --- |
| SES in the sandbox or Supabase cannot send | Visitor asking for a sign-in link: "We could not send the sign-in email. Try again later, or email retrofit@thecreativetoken.com." | Retry later; Phase 2 does not release until SES production access is granted (entry condition) | fake mailer failure -> 503 text (`tests/accounts/sign-in.test.ts`) |
| Sign-in send limit reached | Visitor: the limit text with the local retry time (`retry-time.ts` pattern) | The window ends; the form works again | window test with the fixtures clock |
| Sign-in link expired or already used | Visitor: "This link has expired" and a send-again form prefilled with nothing | Sending a new link | `e2e/account.spec.ts` |
| Claim pending (tag or record not found) | Owner, account page: what was checked (URL or record name), what was found, and "Check again"; DNS text says records can take time to appear | "Check again" | `tests/claims/verify.test.ts` |
| Home page blocked by robots for RetrofitBot | Owner: "Your robots.txt blocks RetrofitBot, so Retrofit cannot read the tag. Use the DNS method instead." | Switching to DNS | claims test with the `blocked` fixture |
| Claim lapsed | Owner: "Verification failed on <date>. Your published page and badge are paused." with "Check again"; public `/s/<host>` and the badge return 404 | One passing check restores both | recheck test, three failures then one pass |
| Published refresh failed | Owner: the error and "Try again"; the public page keeps the previous snapshot and its date | A later successful refresh | publishing test with a failing crawl |
| Stripe webhook late or failed | Customer: account page reconciles from Stripe on load and shows the plan; if Stripe is unreachable, "Activating your plan. Reload in a minute." | Next load or the webhook | `tests/billing/reconcile.test.ts` |
| Checkout cancelled | Customer: back on `/pricing` with "Checkout was cancelled. Nothing was charged." | Starting checkout again | `e2e/billing.spec.ts` |
| Free limit reached (after `BILLING_START`) | Anonymous visitor: "You've used your 5 free analyses. Sign in to keep going." with the sign-in form | Signing in | `tests/billing/free-limit.test.ts` |
| Account deletion with an active subscription | Customer: deletion cancels the subscription first and says so; if Stripe refuses, "We could not cancel your subscription. Nothing was deleted. Try again or email retrofit@thecreativetoken.com." | Retry | `tests/accounts/delete.test.ts` with a failing fake Stripe |
| Missing billing or auth variable on Vercel | Nobody: `loadConfig` refuses and the release's production evidence fails before acceptance | Set the variable; the release playbook's evidence step | `tests/config-*.test.ts` |

## Consumer sweep

Commands run 2026-11-23: `rg -l "\b<name>\b" src tests e2e tools` for each name.

| Shared item | Consumers found | Covered by |
| --- | --- | --- |
| `countClientAnalysis` | `src/lib/analysis/run.ts`, `src/lib/fetch/limits.ts` | Phase 5 (free limit wraps the analysis start; anonymous caps unchanged before `BILLING_START`) |
| `resolveVisitor` | `src/lib/analysis/visitor.ts`, `src/lib/api/analyze.ts` | Phase 2 (account cookie read beside it; visitor cookie unchanged) |
| `readVisitorToken` | `src/lib/analysis/visitor.ts`, `src/lib/api/status.ts`, `src/lib/preview/artifacts.ts` | Phase 2 (owner check also accepts the attached account; tests for both) |
| `createAnalysis` | `src/lib/analysis/record.ts`, `src/lib/analysis/run.ts`, `tests/analysis/record.test.ts` | Phase 2 (optional `accountId`; old records stay valid) |
| `OWN_PAGES` | `src/app/sitemap.ts`, `src/lib/site/own-site.ts`, `tests/site/own-site.test.ts`, `tools/release/production-evidence.mjs` | Phases 1 and 4 (`/pricing`, `/privacy`, `/terms`, published pages; the evidence script's page list updated) |
| `generateNetwork` | as in the 2026-11-22 plan's sweep, plus `src/lib/bundle/files.ts` | Phase 4 (reuses `target: "bundle"`; no change to its output) |
| `src/proxy.ts` matcher | one place | Phase 4 (`s/<host>/bridge/` excluded like `p/<id>/bridge/`) |
| `robots.ts` | `src/app/robots.ts` | Phases 1 and 2 (`/account`, `/auth/` disallowed; `/pricing`, `/s/` allowed) |

## Batch eligibility

- Phase 1: the migration and `AccountData` adapters `[batch-eligible]`; the pricing, privacy and terms pages `[batch-eligible]`; they meet only at the notify route, which the integration owner wires.
- Phase 4: the badge (`src/lib/badge/*`, `src/app/badge/*`) `[batch-eligible]` beside publishing.
- Phases 2, 3 and 5 stay with one implementer each (shared session and entitlement code).

One integration owner merges locally into `develop`; no working branch is pushed and no pull request is opened.

## Coordination with the owner's UI pass

Every phase starts by rebasing on current `develop`. New pages use the existing tokens and components, stay minimal, and keep their copy in one module per page so the UI pass can restyle without touching logic.

## Risks

- SES production access is decided by AWS and may be refused or need more detail; Phase 2 cannot release until it is granted. INFERRED: a short, accurate use statement (transactional sign-in mail only, no marketing sends yet) is the usual path.
- Supabase Auth sends through its own rate limits as well as SES; the plan's own per-email and per-network limits sit below them.
- Publishing makes third-party content public on Retrofit's origin. The claim is the control; a lapsed claim pauses the page within three daily checks.
- `BILLING_START` is one instant in UTC. Tests pin both sides with the fixtures clock; production behavior changes at that instant without a deployment.

## Handoff

- Objective and scope: above. Authorization: planning only. Implementation, every external action in the phase table, every push, deployment and release need Juan's authorization for that action.
- Base: `develop` `e93c3d6`, equal to `origin/develop`; production `7aa6eb1` (`v0.2.0`).
- Specification: `cognizant-ai-labs/agentic-web` HEAD `e34299792cb85f6eb27fed896fdedf65880b458b` (checked 2026-11-22); recheck at Phase 1 entry.
- Overlay: `.rpi/project/rpi-plan.md` is absent; no declared override applied.
- Next: owner acceptance of this plan, then `/rpi-implement` Phase 1 in a worktree from `develop`.
