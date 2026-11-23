# Accounts, claims, publishing and billing implementation

On 2026-11-23 Juan authorized all five phases of 2026-11-23-retrofit-accounts-claims-publishing-billing.md without acceptance stops, local integration into `develop` and removal of the implementation worktree. That authorization covers local work only. It does not cover any external action in the plan's phase table: the production migration, SES production access, SES SMTP credentials, Supabase Auth settings, Stripe accounts or keys, Vercel variables, pushes or releases. Those stay pending.

- Base: `develop` `48c8e121e4e88bbc30c6804566e0ef3b2bcd6eb8` (the plan commit on top of `origin/develop` `e93c3d6`). Production `7aa6eb1` (`v0.2.0`).
- Branch `feat/accounts` in `/Users/juan/code/retrofit-worktrees/accounts`.
- Overlay: `.rpi/project/rpi-implement.md` is absent; no declared override applied.
- Specification: `cognizant-ai-labs/agentic-web` HEAD `c178171d7ef3d0cf5c28208da1263bf954435e70` on 2026-11-23. Compared with the plan's `e342997` and the vendor pin `0516537`, only `docs/agentic_websites.md` changed (eight commits adding directory entries). No vendored file is affected.
- Open UI-pass commits at entry: none (`develop` had only the plan commit beyond `origin/develop`).

## Deviations

- Retention. Plan said analyses live 24 hours plus a 7-day grace (Current state; `saved_reports` purpose). Found: the crawl cache lives 24 hours (`CRAWL_CACHE_TTL_S`), an analysis record 7 days (`ANALYSIS_TTL_S`) and then 7 more days as expired (`src/lib/analysis/record.ts`). Chose: the privacy draft states what the code does, and a test ties the text to the constants. Why: the policy must describe the stored data truthfully. Juan reviews the wording.
- Production evidence pages. Plan said to update the page list in `tools/release/production-evidence.mjs`. Found: that list is the input of the five concurrent analyses, and an analysis uses only the origin, so new paths there would verify nothing. Chose: a new production Playwright case for `/pricing`, `/privacy`, `/terms` and the sitemap (`e2e-prod/pages.spec.ts`). Why: it checks the pages that ship.
- `BILLING_START` on Vercel. Plan said the variable is required on Vercel. Chose: Phase 1 adds `billingStart` with the plan's instant as the default and does not yet require it; Phase 5 makes it required. Why: requiring it in Phase 1 would fail a release of Phase 1 alone before billing exists.
- Unsubscribe. Phase 1 said `GET /unsubscribe?t=<token>` records `unsubscribed_at`. Chose: GET shows a confirmation button; the change happens on `POST /api/unsubscribe`, which also accepts the RFC 8058 one-click body from mailbox providers (so it does not require same-origin). Why: mail link scanners open GET links and would unsubscribe people silently.
- Claim transfer. The parent plan's claim states were `pending`, `verified` and `lapsed`. Chose: the migration adds a terminal `superseded` status with `superseded_at` and `superseded_by`. Why: a host that moves to another account must keep a record of the change, and a lapsed claim of the old owner must never be restored over the new owner (review finding P1-R4).
- Additions beyond the phase file: `findNotifySignup`, `NOTIFY_PER_CLIENT_HOUR` (default 5), a partial unique index for one verified claim per host, and `unique(account_id, host)` on claims.

## Phase 1

Implementation commits `39fbdab`, `cb53803` and `12d1248` added the accounts migration with all eight tables, `AccountData` (memory and Supabase adapters behind one contract suite), `POST /api/notify`, unsubscribe, `/pricing`, `/privacy`, `/terms` and the plan table in `src/lib/billing/plans.ts`. Each unit test failed first on the missing module or route and passed after the change. The database probe passed on its first run, so a mutation that granted `anon` SELECT on `stripe_events` was used to prove it fails ("anon was not denied"); the grant was reverted. The new browser specs were written before the build and were not observed red.

Independent review returned CHANGES REQUIRED with nine findings. Dispositions:

- P1-R1 (S3) fixed in `626fded`: the notify form posts to the API and its button stays disabled until hydration, so an early click can never put an address into a page URL. A markup test failed first. `JudgeForm` and `UrlForm` have the same older pattern; they are outside this plan and stay as they are (recorded for the UI pass).
- P1-R2 fixed in `626fded`: see the unsubscribe deviation.
- P1-R3 deferred to the first mailer: Phase 1 sends no mail. Before any product-news send, the mailer must issue a fresh unsubscribe token at send time (only the hash is stored) and confirm the address (double opt-in). No phase of this plan sends notify mail.
- P1-R4 fixed in `bc67808`: the `superseded` claim status. The probe failed first with `42703 column "superseded_at" ... does not exist`.
- P1-R5 fixed: `/unsubscribe` joined the phone-width and color-scheme specs.
- P1-R6 fixed in `2a8ed26`: production case `own-pages` (`e2e-prod/pages.spec.ts`). It fails against `v0.2.0` until a release ships these pages.
- P1-R7 fixed by this notes file.
- P1-R8 fixed: the privacy draft says the free AI keeps usage and cost counts and never the conversation (verified against the inference proxy log calls, which carry only error codes and pool names), and that Retrofit sends no email yet.
- P1-R9 fixed: the Playwright server raises `NOTIFY_PER_CLIENT_HOUR`.

The integration owner reviewed the repair diffs and approved them. The simplify pass (four angles) produced `1bf7963`: one shared Supabase service client and failure wrapper, one adapter choice in the runtime with lazy account data, `countClientWindow`, one token module, a general lint rule for Supabase adapters, the `SitePage` shell, `PRIVATE_PATHS`, shared request texts, and removal of the unused unsubscribe URL builders (a mailer adds them back). Skipped with reasons: the `privacyHref` prop (the plan refuses the form without a privacy link), `findNotifySignup` (the contract suite reads it), a one-round-trip unsubscribe function (only the repeat path pays a second call), a shared client `post()` with the older `JudgeForm`, a per-spec Playwright client identity, and the memory adapter's linear token lookup (tests only).

Owner manual check 1 (approve `/privacy` and `/terms`) is required before any release that includes this phase. The phase gate runs on the commit containing this entry; Phase 2 records its receipt.
