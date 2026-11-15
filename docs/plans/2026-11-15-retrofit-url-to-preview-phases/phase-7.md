# Phase 7: Supabase store, gate database, evidence analyzer, production peer, hosting and first release

Parent plan: [2026-11-15-retrofit-url-to-preview.md](../2026-11-15-retrofit-url-to-preview.md).

## Goal

Retrofit runs at `https://retrofit.thecreativetoken.com` with a Supabase store and links, with consent, to the synthetic peer `https://demo-harbor.thecreativetoken.com`. The release follows `docs/release/release-playbook.md` with a tested evidence analyzer, and every spec §6 check passes in production. Local work comes first; every external action has its own authorization.

## Entry conditions

- Phase 6 accepted.
- Re-read `cognizant-ai-labs/agentic-web` and record the commit.
- Read `.rpi/rules/resource-lifecycle.md`, `.rpi/rules/supabase.md`, `.rpi/rules/deployment-safety.md` and the playbook again.

## Local work

### Supabase adapter

- `supabase/config.toml`: `project_id = "retrofit"`, reusable dev block: shadow DB 54720, API 54721, DB 54722, Studio 54723, Inbucket 54724, analytics 54727, pooler 54729.
- Migration `supabase/migrations/<timestamp>_store.sql`:
  - tables `kv (key text primary key, value jsonb not null, version bigint not null, expires_at timestamptz not null)`, `counters (key text, window_start timestamptz, count bigint not null, primary key (key, window_start))`, `leases (key text primary key, token uuid not null, expires_at timestamptz not null)`
  - functions `store_put_if_absent`, `store_compare_and_set`, `store_increment_window`, `store_acquire_lease`, `store_renew_lease`, `store_release_lease`: `security invoker`, `set search_path = ''`, fully qualified names
  - RLS on every table with no policies; `revoke all` on tables and `revoke execute` on functions from `public`, `anon` and `authenticated`; grants to `service_role` only; default privileges checked for future tables and functions
- `src/lib/store/supabase.ts`: the `Store` contract with `@supabase/supabase-js` and the service role key (server only); expired rows ignored and deleted on read.
- `src/app/api/cron/cleanup/route.ts`: deletes expired rows; `Authorization: Bearer <CRON_SECRET>`.
- On Vercel, missing Supabase configuration fails at startup (no fallback to memory). A failed read logs `[TABLE_FALLBACK]` at ERROR.
- `src/app/api/health/route.ts`: writes and reads a `kv` row with a 60 s TTL; `ok`, or `degraded` with 503.

### Gate database

- `pnpm test:db` runs the Vitest `db` project against a disposable stack: `project_id = "retrofit-gate"`, ports 54730 to 54739, config generated into `.local/supabase-gate/`.
- One machine-wide coordination directory outside every worktree: `~/Library/Application Support/retrofit/gate-db/`, holding `lock` and `receipt.json`.

```
@ runGateDb() -> exit code
ctx: supabase CLI, docker CLI, coordination directory, worktree
pre: owner accepted this plan, which authorizes disposal of the retrofit-gate identity only when it matches this run's receipt
do:
  1. acquire the machine-wide lock (held -> exit 1 naming holder pid, worktree and start time)
  2. inspect the Docker context, containers and volumes labelled for project retrofit-gate
  3. refuse when any exist and receipt.json is absent or belongs to another run (report them; never reset or remove)
  4. write receipt.json (never overwrite one): context, project, ports, worktree, pid, start time; start the stack
  5. verify the containers carry the project label and this workdir; reset; run the db project and SQL tests
  6. verify identity again; stop with --no-backup; verify removal; delete receipt; release lock
fail: test failure -> still dispose and release; keep the first failure and any cleanup failure separately
risk: a replaced container with the same name is not the recorded resource; compare ids from step 5
```

- `pnpm gate-db:recover`: for a receipt whose pid is dead, re-inspects; disposes only when every resource matches the receipt; otherwise reports and leaves everything in place.
- The reusable dev stack `retrofit` is never touched by the gate.
- Add `pnpm test:db` to `.rpi/policy.json` after `pnpm test:coverage`.

### Production peer

- `peers/demo-harbor/`: a synthetic "Harbor tours demo" site (fictional tours, no third-party names or trademarks) with network `harbor_tours` (two agents, answers from its own static content), `agent-manifest.json` with a closed `peer_policy`, built with `build_network.mjs`.
- The deployment serves `peers/demo-harbor/` only for requests with host `demo-harbor.thecreativetoken.com` (host check in the request hook; the main host returns 404 for those paths), with CORS `*` on its public artifacts and a page CSP of its own.
- Retrofit's network adds the tool `https://demo-harbor.thecreativetoken.com/harbor_tours` with a link label, and `allowed_peers` `["https://demo-harbor.thecreativetoken.com"]`. `buildConnectSrc` adds that origin.
- `e2e/spec6.spec.ts` gains a case that runs the production-shaped caller (same manifest, peer served by the fixture server under the peer host name mapped to loopback).

### Evidence analyzer

`tools/release/analyze-evidence.mjs <candidate-commit>` reads `.rpi/local/verification.json` and `.local/evidence/current/`. It rejects:

- `attempt.json` commit or tree different from the candidate, or from `verification.json` identity
- `attempt.json` start earlier than `verification.json` `started_at`, or a report not listed in the seal, or a report whose hash differs from the seal
- any required check missing or with a non-zero exit
- zero passing tests in any suite; any skipped or missing test in `tools/release/required-tests.json`
- coverage below the bar
- a gate database run without a completed teardown in its log

`tools/release/required-tests.json` lists the full test titles that prove the safety and conformance rules: fetch guard and robots, pacing, client limits, crawl job fencing, privacy (both parts), key panel, origins, redirects, hostile output, unofficial label, §6 (all cases), conformance, free path, proxy budget and reservation tests, redaction, credit check.

### Hosting configuration

- `vercel.json`: `"git": {"deploymentEnabled": {"develop": false, "sutura/*": false}}`; `"ignoreCommand": "test \"$VERCEL_ENV\" != \"production\""`; `maxDuration` 60 for analyze, score and inference routes; crons for cleanup (daily) and credit check (daily).
- Playbook: artifact, state, rollback (`vercel rollback` with owner authorization) and Wave A commands for this stack.
- `docs/development/resource-lifecycle.md`: dev stack and gate stack, as above.

## Tests (write first)

- `tests/db/store.test.ts`: the shared contract suite against the gate stack, including two Supabase clients.
- `supabase/tests/store_access.sql`: as `anon` and `authenticated`, table select, insert, update and every function `rpc` call are denied; as `service_role` they work; a later table and a later function are not usable by `anon`.
- `tests/store/supabase-failure.test.ts`: adapter on a closed port gives `degraded` health, the "having trouble" text, and `[TABLE_FALLBACK]` in logs.
- `tests/tools/gate-db.test.ts` (CLI shims for `docker` and `supabase` at the process boundary): two concurrent runs (second exits 1); inherited stack without a receipt (refused, nothing reset); receipt from another run (refused); replaced container id between steps 5 and 6 (no disposal); interruption leaves a receipt that `gate-db:recover` handles; a cleanup failure is reported separately from a test failure.
- `tests/release/analyze-evidence.test.ts`: one fixture per rejection and one accepted set.
- `tests/api/cleanup.test.ts`, `tests/routes/peer-host.test.ts` (peer paths 404 on the main host; served with CORS on the peer host).
- One real `pnpm test:db` run on the developer machine is part of acceptance, with the receipt and teardown log kept.

## External actions (each needs the owner's authorization for that exact action)

In order. Inspect the target before each and record the result.

1. **Confirm Vercel's function region** for team `thecreativetoken`; choose the Supabase region next to it.
2. **Create the Supabase project** `retrofit` in that region.
3. **Apply the migration** with `supabase db push` after `supabase migration list` on the linked project.
4. **Create the Vercel project** `retrofit` in team `thecreativetoken` without a Git connection.
5. **Create the alert token**: a fine-grained GitHub token with Issues write on `juan294/retrofit` only, expiring 2027-01-31. Fine-grained tokens are created in GitHub's settings pages; use browser automation with the owner present, and the owner confirms the scope before it is saved.
6. **Set production environment variables**: `SESSION_SECRET`, `CRON_SECRET` (generated locally, never printed), `PUBLIC_ORIGIN`, `OTARI_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `JUDGE_CODE`, `ALERT_GITHUB_TOKEN`, ledger and cap variables. Production only.
7. **Add the domains** `retrofit.thecreativetoken.com` and `demo-harbor.thecreativetoken.com` and read the DNS targets.
8. **Create the Route 53 records**: one `UPSERT` change batch in zone `Z05609513HH99AFEUOPD3` for both names. Show the batch file to the owner before `aws route53 change-resource-record-sets`; wait for `INSYNC`.
9. **Release** (playbook steps 1 to 8): merge `develop` into `main` locally with a merge commit; run the full gate on it; run the evidence analyzer; present the evidence; push `main` once (nothing deploys, Git is not connected); `vercel deploy --prod` from a clean checkout of that commit.
10. **Connect Git** so later merges to `main` deploy; confirm the production branch is `main`; if the connection starts a deployment, confirm it is a production deployment of the same commit.

## Post-release verification

- `check_partner.mjs` exits 0 for `https://retrofit.thecreativetoken.com/retrofit_guide` and `https://demo-harbor.thecreativetoken.com/harbor_tours`.
- `/api/health` returns `ok`.
- `e2e-prod/spec6.spec.ts`, run once against production with the free path: consent card for `demo-harbor.thecreativetoken.com`, decline sends nothing, approval runs the peer in the browser, no peer request carries the session cookie or a key, the router stays Retrofit's, private context absent, denied origin and invalid network show errors (the cycle and over-budget cases stay local, because they need hostile peers).
- Analyze `https://retrofit.thecreativetoken.com/` (Retrofit reads itself): score ready, the three agentic-web checks pass, the preview answers one question on the free path.
- Five concurrent analyses of Retrofit's own pages: record timings and status latency.
- `vercel list` shows no deployment with the preview target.
- Judge path: open `/judges`, enter the code, confirm the session reports `pool: judge`.
- Inspect every deployment for the pushed commit. On failure, no rerun or redeploy; report, reproduce locally, roll back under the playbook if production is affected.

## Automated success criteria

- The full gate passes on the merge commit, including `pnpm test:db`; the analyzer accepts the candidate.

## Manual success criteria

- Each external action recorded with its authorization and result; post-release checks recorded.
- `.rpi/release-profile.json`: every `required_before_first_release` item satisfied with evidence paths, including `open-agentic-web-spec-conformance-evidence` (local §6, production §6 spec, both partner checks).
- Judge-access delivery recorded as a submission acceptance item: where the code will be given (judges-only Devpost field if it exists, else public text), and the reserve amount.

## Independent work units

- `[batch-eligible]` Unit A: Supabase config, migration, SQL tests, adapter, contract and failure tests.
- `[batch-eligible]` Unit B: gate database tool and tests.
- `[batch-eligible]` Unit C: evidence analyzer, required-tests list and tests.
- `[batch-eligible]` Unit D: production peer, host routing and tests.
- `[batch-eligible]` Unit E: `vercel.json`, health and cleanup routes, playbook and resource documents.
- External actions are sequential and owned by the integration owner.

## Stuck states in this phase

Store unavailable; gate database held, inherited or interrupted; evidence stale. See the parent plan table. A failed deploy is handled by rollback, never by redeploying to diagnose.

## Exit

Stop for owner acceptance. The next step is the second plan.
