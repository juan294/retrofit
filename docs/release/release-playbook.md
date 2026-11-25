# Retrofit release procedure

This is the single release procedure for Retrofit. Native `rpi-release` delegates to it. Repository setup is not a release. Juan owns publication, hosting, provider and rollback decisions.

## Present readiness

The application is built through Phase 7's local work (`docs/plans/2026-11-15-retrofit-url-to-preview-notes.md`). Release readiness is **BLOCKED** until the Phase 7 external actions are authorized and done (hosting, database, domains, production evidence), the owner's Phase 6 inputs exist (Otari key, prices, credit, reserve, judge code, contract probe) and the `rpi-installation` gate check passes again. Do not report a test count or coverage that the current gate run did not produce.

Machine-readable selection and gaps are in `.rpi/release-profile.json`.

## Adaptation profile

| Area | Retrofit decision |
| --- | --- |
| Product | Next.js 16 web tool and the vendored agentic-web browser runtime (`docs/decisions/2026-11-15-stack-and-hosting.md`). |
| Repository | `juan294/retrofit`. Public since 2026-11-15, by Juan's authorization. |
| Branches | `develop` integration, `main` production, merge-commit promotion. |
| Artifact | One Vercel production deployment of the merge commit on `main`, serving `retrofit.thecreativetoken.com` and, host-routed, `demo-harbor.thecreativetoken.com`. `/api/version` reports the commit (`BUILD_COMMIT`). |
| State | Supabase Postgres project `retrofit`: crawl jobs, visitor-owned analyses (7 days), free-inference sessions, quotas, the ledger and the overrun hold. Visitor LLM keys stay in the browser and are never server state. |
| Network | Server: guarded fetch of public sites (robots, pacing, SSRF guard) and the Otari upstream for the free path. Browser: the visitor's provider router or Retrofit's free path, and consented peers. |
| Release owner | Juan |
| Rollback | First release: remove the production aliases with owner authorization. Later releases: `vercel rollback <previous deployment>` with owner authorization; the database keeps its data (no destructive migration in this plan). |
| Hosted CI | None in this repository. Sutura owns fleet CI routing (`docs/development/ci-handoff.md`). |
| Deadline | Submission closes 2027-01-11 8:00 am PT. Judges need free access until 2027-01-18 17:00 Pacific time (2027-01-19T01:00Z). |
| Wave A | Mandatory: fixed candidate, nonempty passing evidence, required miss blocks, tag last. |
| Wave B | Not selected. Retrofit ships no code that runs unattended or destructively on users' machines. |
| Waves C to H | Reassess before the second plan's release. |

### Wave A commands for this stack

1. Candidate: merge `develop` into `main` locally with a merge commit; `git status` clean.
2. Local gate on that commit: `python3 .rpi/scripts/rpi-verify.py` (includes `pnpm test:db`, the disposable gate database, and `pnpm test:e2e`).
3. Local analysis: `node tools/release/analyze-evidence.mjs <merge commit>`. Any accepted exception (`--accept-failed-check <name> --reason <text>`) is shown to Juan with the candidate.
4. After the authorized candidate deployment (`vercel deploy --prod --build-env BUILD_COMMIT=<merge commit>` from a clean checkout of that commit): production evidence into `.local/evidence/production/<deployment id>/` (phase-7.md "Production evidence"), then `node tools/release/analyze-evidence.mjs <merge commit> --production .local/evidence/production/<deployment id>`.
   - Deployment identity: `/api/version` names only a commit, and two deployments of one commit can differ. `tools/release/production-evidence.mjs` therefore runs `vercel inspect <target> --format json` for the deployment URL, `retrofit.thecreativetoken.com` and `demo-harbor.thecreativetoken.com` (the `aliases` of the `alias-binding` case in `tools/release/required-production-cases.json`) before the first case and again after the last. Each must name the candidate deployment id both times. A host bound to another deployment, or one that Vercel cannot inspect, fails `alias-binding`; when this happens before the suites, the script stops and runs no suite. The analyzer rejects a binding case without this identity and any case recorded outside the two checks.
5. Juan's final acceptance, then the release tag last through `rpi-release`.

### Production variables for accounts and billing

`loadConfig` (`src/lib/config.ts`) refuses a Vercel start without the required ones, so a missing one fails the production evidence before acceptance. Values are never written to the repository, logs or evidence. The free-path, store and origin variables are in `docs/plans/2026-11-15-retrofit-url-to-preview-phases/phase-7.md`.

| Variable | Rule on Vercel |
| --- | --- |
| `SUPABASE_ANON_KEY` | Required. Sign-in through Supabase Auth, server side only. |
| `BILLING_START` | Required: `2027-01-20T00:00:00Z`. An earlier instant is refused (the hackathon asks for hosting until 2027-01-18 17:00 Pacific time, 2027-01-19T01:00Z). |
| `STRIPE_SECRET_KEY` | Optional until `BILLING_START`, then needed to sell plans: without it plan limits apply, nobody can buy a plan, and the daily credit check opens one alert issue. Set it with `STRIPE_WEBHOOK_SECRET` or not at all. Test mode only (`sk_test_` or `rk_test_`). A live key is refused; the live switch is a separate authorized release with its own webhook, prices and cleared test-mode billing rows. |
| `STRIPE_WEBHOOK_SECRET` | Set exactly when `STRIPE_SECRET_KEY` is set (`whsec_`): the signing secret of the test webhook endpoint `/api/billing/webhook` for `checkout.session.completed`, `customer.subscription.updated` and `customer.subscription.deleted`. |
| `STRIPE_PRICE_PRO`, `STRIPE_PRICE_AGENCY` | Optional until Juan sets the amounts; a Stripe price id (`price_`) or a comma-separated list. The first id is for sale; every id of the list is recognised as its plan. To change a price, put the new id first and keep the old one in the list while it has subscribers. The two lists share no id. A plan without one, or whose amount cannot be read, has no upgrade button. |
| `ACCOUNT_SITES_PER_DAY_FREE`, `ACCOUNT_SITES_PER_DAY_PRO`, `ACCOUNT_SITES_PER_DAY_AGENCY` | Optional (50, 100, 300). Distinct sites one account may analyze and score per UTC day from `BILLING_START`; never more than half of `CRAWL_MAX_HOSTS_PER_DAY`. |

A change of a Stripe variable takes effect with the next production deployment. Stripe's customer portal needs a saved test configuration (update the card, cancel, and switch between the two prices) before "Manage billing" works. Apply `supabase/migrations/20261123170000_billing.sql` with the release. A log line `[BILLING_ALERT]` names a customer of this Retrofit without a billing record and without a deletion mark (for example after restoring a database): nothing was cancelled; check it in Stripe.

## Required ordering

1. Confirm the exact release scope with Juan. Confirm a clean candidate, the integration and production refs, and the retained-resource state. Do not publish working branches.
2. Freeze the candidate commit and its dependency identities.
3. Run local checks sequentially with `.rpi/policy.json` and `.rpi/scripts/rpi-verify.py`. Add the real automated tests and coverage to the declared selection before any release. No required failure or skip may become a pass.
4. Prove conformance for the exact candidate: a valid `agent-manifest.json`, a runtime that runs the network in the browser, and an interface for users or agents. Use the organizers' validation script if one exists at that time. Record which version of the specification was checked.
5. Prove the safety rules: the visitor key never leaves the browser, robots rules and per-site limits hold, a preview of an unclaimed site is private and labelled unofficial, and consent comes before contact with a third-party origin.
6. Analyze the candidate's evidence with a tested analyzer. It must reject zero passes, missing, failed or skipped required probes, a mismatched commit, and missing cleanup. The analyzer is a first-release prerequisite and does not exist at bootstrap. A prose checklist cannot replace it.
7. Present the source identity, automated results, conformance and safety evidence, known issues and the rollback artifact to Juan. Get the authorization for the concrete publication action.
8. Promote the verified tree with a merge commit, confirm its identity, then create the release tag last through `rpi-release`. Publish only the authorized artifact and destination and inspect the exact result. Do not use a rerun or re-push loop to debug.

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
