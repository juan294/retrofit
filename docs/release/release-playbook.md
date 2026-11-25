# Retrofit release procedure

This is the single release procedure for Retrofit. Native `rpi-release` delegates to it. Repository setup is not a release. Juan owns publication, hosting, provider and rollback decisions.

## Present readiness

v0.1.0 (2026-11-20) and v0.2.0 (2026-11-22, `7aa6eb1`) are released; the machine-readable record is `.rpi/release-profile.json`. The next release is v0.3.0: accounts, claims, publishing, billing in Stripe test mode. It is **not ready** until all of these are true:

- The pre-launch Wave 1 repairs are merged and the gate and the analyzer accept the candidate.
- Juan approved the texts of `/privacy` and `/terms` and did the UI review (owner checks 1 and 5 of the accounts plan).
- The production steps below are authorized, each one by name.

Do not report a test count or coverage that the current gate run did not produce.

## Adaptation profile

| Area | Retrofit decision |
| --- | --- |
| Product | Next.js 16 web tool and the vendored agentic-web browser runtime (`docs/decisions/2026-11-15-stack-and-hosting.md`). |
| Repository | `juan294/retrofit`. Public since 2026-11-15, by Juan's authorization. |
| Branches | `develop` integration, `main` production, merge-commit promotion. |
| Artifact | One Vercel production deployment of the merge commit on `main`, serving `retrofit.thecreativetoken.com` and, host-routed, `demo-harbor.thecreativetoken.com`. `/api/version` reports the commit (`BUILD_COMMIT`). |
| State | Supabase Postgres project `retrofit` (us-east-1; functions are pinned to `iad1`). Temporary: crawl jobs, visitor-owned analyses (7 days), free-inference sessions, quotas, the ledger and the overrun hold. Durable since v0.3.0: accounts, claims, saved reports, published sites, API-key hashes, billing rows, notify signups and the Supabase Auth users. Visitor LLM keys stay in the browser and are never server state. |
| Network | Server: guarded fetch of public sites (robots, pacing, SSRF guard) and the Otari upstream for the free path. Browser: the visitor's provider router or Retrofit's free path, and consented peers. |
| Release owner | Juan |
| Rollback | `vercel rollback <previous deployment>` with owner authorization. For v0.3.0 the target is v0.2.0, `dpl_DiLC69wsp8xZ2QJnxa2xD7ehLouu`. Never roll back the migrations: they only add objects, and v0.2.0 uses none of them. Effects of v0.2.0 on v0.3.0 data: public pages and badges answer 404, sign-in links already sent answer 404, and nobody can delete an account or unsubscribe, so fix forward soon. After a rollback, pushes to `main` do not take the domains until a deployment is promoted (INFERRED from Vercel's documentation): end it with `vercel promote <deployment>`. |
| Hosted CI | `.github/workflows/ci.yml` (Gate and Database) runs on every push of `develop` and `main`. It is a second check, not the release gate: the local gate and the analyzer decide. Sutura owns cadence and routing. |
| Deadline | Submission closes 2027-01-11 8:00 am PT. Judges need free access until 2027-01-18 17:00 Pacific time (2027-01-19T01:00Z). |
| Wave A | Mandatory: fixed candidate, nonempty passing evidence, required miss blocks, tag last. |
| Wave B | Not selected. Retrofit ships no code that runs unattended or destructively on users' machines. |
| Waves C to H | Juan decides for v0.3.0 when the candidate is presented. Proposed: not selected, because the pre-launch audit of 2026-11-25 covered all nine domains on this candidate line. |

### Wave A commands for this stack

A push to `main` deploys production: Git is connected, and the steps 10 to 15 of `phase-7.md` applied to the first release only. So the database and the variables come first. Each step marked (authorized) needs Juan's authorization by name.

1. Candidate: merge `develop` into `main` locally with a merge commit, in a detached release worktree; `git status` clean.
2. Local gate on that commit: `python3 .rpi/scripts/rpi-verify.py` (includes `pnpm test:db`, the disposable gate database, and `pnpm test:e2e`). Local analysis: `node tools/release/analyze-evidence.mjs <merge commit>`. Any accepted exception (`--accept-failed-check <name> --reason <text>`) is shown to Juan with the candidate. Strix on the candidate.
3. Backup (authorized): confirm today's physical backup with `supabase backups list --remote=uqsiliezqcyzpmbvuruh`. See "Backup and restore".
4. Migrations (authorized): in the linked checkout `supabase migration list --remote=uqsiliezqcyzpmbvuruh`, then `supabase db push --remote=uqsiliezqcyzpmbvuruh --dry-run`. It must list exactly the files of `supabase/migrations/` that are not applied, in order, and nothing else; then the same without `--dry-run`. Without `--remote` the command acts on the local stack. Compare the list again. Precondition: every waiting file only adds objects and touches no `kv`, `counters`, `leases`, `queue` or `store_*` object, so the live release keeps working. A migration that does more needs its own order.
5. Auth settings (authorized): `node tools/ops/production-auth.mjs` shows the difference; `--apply --project=uqsiliezqcyzpmbvuruh` applies it. Never `supabase config push` with `supabase/config.toml`.
6. Variables (authorized): set the required ones below in Vercel Production and compare the names. A missing or malformed one now fails the build (`src/lib/build-config.ts`) and the running deployment keeps serving.
7. Push `main` (authorized). This is the deployment. Take its `dpl_` id from Vercel and wait for READY; inspect CI for the exact commit.
8. Production evidence into `.local/evidence/production/<deployment id>/` (phase-7.md "Production evidence"), with `JUDGE_CODE` in the environment, then `node tools/release/analyze-evidence.mjs <merge commit> --production .local/evidence/production/<deployment id>`. `account-data-ready` proves the migrations, `sign-in-send` proves that the provider sent an email (a new address of the Amazon SES mailbox simulator; one of the 5 an hour of this network).
   - Deployment identity: `/api/version` names only a commit, and two deployments of one commit can differ. `tools/release/production-evidence.mjs` therefore runs `vercel inspect <target> --format json` for the deployment URL, `retrofit.thecreativetoken.com` and `demo-harbor.thecreativetoken.com` (the `aliases` of the `alias-binding` case in `tools/release/required-production-cases.json`) before the first case and again after the last. Each must name the candidate deployment id both times. A host bound to another deployment, or one that Vercel cannot inspect, fails `alias-binding`; when this happens before the suites, the script stops and runs no suite. The analyzer rejects a binding case without this identity and any case recorded outside the two checks.
9. Owner checks on that deployment id, recorded in the plan's notes: one real sign-in link received, opened and signed in; a site claimed, published and its badge embedded.
10. Juan's final acceptance, then the release tag last through `rpi-release`.

### Backup and restore

Supabase makes one physical backup of the whole database a day (six were listed on 2026-11-25) and the project has no point-in-time recovery, so up to one day of data can be lost. Before the migrations of a release that stores durable data, take one logical dump of `auth` and `public` (authorized) into an encrypted place outside the repository, and delete it after 30 days: it holds email addresses, and `/privacy` promises deletion. Restore order: stop the crons (disable them in Vercel), restore the whole project (a `public` table without `auth.users` breaks every foreign key), compare the migration list, delete again every account that was deleted after the backup (the deletion marks in `deleted_customers` and the Stripe dashboard name the paying ones; tell Juan about the others), then start the crons. Never run a restore from the gate.

### Production variables for accounts and billing

`loadConfig` (`src/lib/config.ts`) refuses a Vercel start without the required ones, so a missing one fails the production evidence before acceptance. Values are never written to the repository, logs or evidence. The free-path, store and origin variables are in `docs/plans/2026-11-15-retrofit-url-to-preview-phases/phase-7.md`.

| Variable | Rule on Vercel |
| --- | --- |
| `SUPABASE_ANON_KEY` | Required. Sign-in through Supabase Auth, server side only. |
| `SIGNIN_PER_CLIENT_HOUR`, `SIGNIN_PER_EMAIL_NETWORK_HOUR`, `SIGNIN_PER_EMAIL_HOUR` | Optional (5, 2, 3). Sign-in links per hour: per network, per network and address, and per address. A browser that signed in to the address before can get one more an hour. Amazon SES was told 3 per address and 5 per network; do not raise the variables above that. |
| `SIGNIN_VERIFY_PER_CLIENT_HOUR` | Optional (20). Sign-in links checked per network and hour, before the provider's shared limit. |
| `BILLING_START` | Required: `2027-01-20T00:00:00Z`. An earlier instant is refused (the hackathon asks for hosting until 2027-01-18 17:00 Pacific time, 2027-01-19T01:00Z). |
| `STRIPE_SECRET_KEY` | Optional until `BILLING_START`, then needed to sell plans: without it plan limits apply, nobody can buy a plan, and the daily credit check opens one alert issue. Set it with `STRIPE_WEBHOOK_SECRET` or not at all. Test mode only (`sk_test_` or `rk_test_`). A live key is refused; the live switch is a separate authorized release with its own webhook, prices and cleared test-mode billing rows. |
| `STRIPE_WEBHOOK_SECRET` | Set exactly when `STRIPE_SECRET_KEY` is set (`whsec_`): the signing secret of the test webhook endpoint `/api/billing/webhook` for `checkout.session.completed`, `customer.subscription.updated` and `customer.subscription.deleted`. |
| `STRIPE_PRICE_PRO`, `STRIPE_PRICE_AGENCY` | Optional until Juan sets the amounts; a Stripe price id (`price_`) or a comma-separated list. The first id is for sale; every id of the list is recognised as its plan. To change a price, put the new id first and keep the old one in the list while it has subscribers. The two lists share no id. A plan without one, or whose amount cannot be read, has no upgrade button. |
| `ACCOUNT_SITES_PER_DAY_FREE`, `ACCOUNT_SITES_PER_DAY_PRO`, `ACCOUNT_SITES_PER_DAY_AGENCY` | Optional (50, 100, 300). Distinct sites one account may analyze and score per UTC day from `BILLING_START`; never more than half of `CRAWL_MAX_HOSTS_PER_DAY`. |

The alert token (`ALERT_GITHUB_TOKEN`) expires on 2027-01-31; renew it before that day, or every alert stops. A change of a Stripe variable takes effect with the next production deployment. Stripe's customer portal needs a saved test configuration (update the card, cancel, and switch between the two prices) before "Manage billing" works. Every migration is applied before the deployment (Wave A step 4). A log line `[BILLING_ALERT]` names a customer of this Retrofit without a billing record and without a deletion mark (for example after restoring a database): nothing was cancelled; check it in Stripe.

## Required ordering

1. Confirm the exact release scope with Juan. Confirm a clean candidate, the integration and production refs, and the retained-resource state. Do not publish working branches.
2. Freeze the candidate commit and its dependency identities.
3. Run local checks sequentially with `.rpi/policy.json` and `.rpi/scripts/rpi-verify.py`. Add the real automated tests and coverage to the declared selection before any release. No required failure or skip may become a pass.
4. Prove conformance for the exact candidate: a valid `agent-manifest.json`, a runtime that runs the network in the browser, and an interface for users or agents. Use the organizers' validation script if one exists at that time. Record which version of the specification was checked.
5. Prove the safety rules: the visitor key never leaves the browser, robots rules and per-site limits hold, a preview of an unclaimed site is private and labelled unofficial, and consent comes before contact with a third-party origin.
6. Analyze the candidate's evidence with a tested analyzer. It must reject zero passes, missing, failed or skipped required probes, a mismatched commit, and missing cleanup. The analyzer is `tools/release/analyze-evidence.mjs`. A prose checklist cannot replace it.
7. Present the source identity, automated results, conformance and safety evidence, known issues and the rollback artifact to Juan. Get the authorization for the concrete publication action.
8. Follow "Wave A commands" in order: database and settings first, then the push of `main`, which deploys, then the evidence. Confirm the identity, then create the release tag last through `rpi-release`. Publish only the authorized artifact and destination and inspect the exact result. Do not use a rerun or re-push loop to debug.

## Hackathon submission

The Devpost submission is an outward-facing action that needs Juan's authorization for the exact content. It needs a public URL, a video under 2 minutes on YouTube with Juan explaining and no third-party trademarks, a text description and screenshots. Making the repository public is a separate authorized action.

## Free-path overrun recovery

An overrun hold closes the public free pool until Juan reconciles the bound, prices, provider balance and outstanding reservations. Resuming production is an authorized owner action. Run it from a clean checkout with the production store, the credit, the judge reserve, the prices and the service end in the environment (all seven are required):

```sh
SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... FREE_CREDIT_USD=... JUDGE_RESERVE_USD=... \
FREE_PRICE_IN_PER_M=... FREE_PRICE_OUT_PER_M=... FREE_SERVICE_END=... \
pnpm ops:resume-free --reconciled-balance <usd> --note <text>
```

The other free-path settings (per-request fee, bound and limits) keep their `src/lib/config.ts` defaults when unset. The command prints every effective setting and marks each default; set any value that production overrides, then rerun. It prints the target store's origin and the ledger, hold and bound before any change, writes an `inference:audit:<time>` record, then clears the hold. A refusal or a store failure adds a `resume-free-refused` or `resume-free-failed` audit record. Exit status: 0 resumed; 1 refused (missing balance or note, balance below the ledger's remaining credit, no hold, or a new overrun recorded while it ran, which keeps the hold); 2 store or ledger configuration missing; 3 store error (nothing was reported as resumed); 4 the ledger hold was cleared but a legacy `inference:hold` record from the earlier layout could not be deleted (a `resume-free-legacy-delete-failed` audit record notes the error; that record still closes the public pool, so rerun the command). After a refusal for a new overrun, inspect the new state and reconcile again. `tests/db/resume-free.test.ts` runs the executable against the disposable gate stack only.

## Evidence and rollback

Keep raw logs, screenshots and fetched site copies under ignored `.local/` or `.rpi/local/`. Curated release summaries may live under `docs/release/`. Each result names the candidate commit, environment, time, command or procedure, outcome and cleanup disposition.

A key leak, a public page for an unclaimed site, or abuse of the fetch service after release requires stopping the rollout and presenting the exact rollback artifact and scope to Juan. Preserve the failure evidence and user data.
