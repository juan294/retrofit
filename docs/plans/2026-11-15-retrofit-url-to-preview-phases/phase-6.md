# Phase 6: Supabase store, evidence analyzer, Vercel hosting, DNS and first production release

Parent plan: [2026-11-15-retrofit-url-to-preview.md](../2026-11-15-retrofit-url-to-preview.md).

## Goal

Retrofit runs at `https://retrofit.thecreativetoken.com` with a Supabase store. The release follows `docs/release/release-playbook.md` with a tested evidence analyzer. The organizers' partner check passes in production. Local work comes first; every external action has its own authorization.

## Entry conditions

- Phase 5 accepted.
- Re-read `cognizant-ai-labs/agentic-web` and record the commit (as in Phase 4).
- Read `.rpi/rules/resource-lifecycle.md`, `.rpi/rules/supabase.md`, `.rpi/rules/deployment-safety.md` and `docs/release/release-playbook.md` again.

## Local work

### Supabase adapter

- `supabase/config.toml`: `project_id = "retrofit"`, ports in the reusable dev block: shadow DB 54720, API 54721, DB 54722, Studio 54723, Inbucket 54724, analytics 54727, pooler 54729.
- Migration `supabase/migrations/<timestamp>_store.sql`:
  - tables `kv (key text primary key, value jsonb not null, expires_at timestamptz not null)`, `counters (key text, window_start timestamptz, count integer not null, primary key (key, window_start))`, `locks (key text primary key, expires_at timestamptz not null)`
  - functions for atomic window increment and lock acquire
  - RLS on every table with no policies; `revoke all` from `anon` and `authenticated`; grants to `service_role` only; default privileges checked for future tables
- `src/lib/store/supabase.ts`: the `Store` contract with `@supabase/supabase-js` and the service role key (server only). Expired rows are ignored and deleted on read.
- `src/app/api/cron/cleanup/route.ts`: deletes expired rows; accepts only `Authorization: Bearer <CRON_SECRET>` (Vercel Cron); daily schedule in `vercel.json`.
- Production selects the Supabase adapter; on Vercel, missing Supabase configuration fails at startup (no fallback to memory). A failed read logs `[TABLE_FALLBACK]` at ERROR.
- `src/app/api/health/route.ts`: writes and reads a `kv` row with a 60 s TTL; returns `ok`, or `degraded` with HTTP 503.

### Disposable gate database

- The gate check `pnpm test:db` uses a separate disposable stack: `project_id = "retrofit-gate"`, ports 54730 to 54739, workdir `.local/supabase-gate/` (a generated copy of `supabase/` with those values).
- `tools/gate-db.mjs`:

```
@ runGateDb() -> exit code
ctx: supabase CLI, Docker context, .local/supabase-gate/
pre: owner accepted this plan, which authorizes disposal of exactly this recorded identity
do:
  1. acquire .local/supabase-gate/lock with pid and start time (held lock -> exit 1 with holder)
  2. write ownership record: Docker context, project_id retrofit-gate, workdir, ports, start time
  3. start stack; reset; run contract suite and SQL tests
  4. verify the running containers carry project retrofit-gate and the recorded workdir
  5. stop with --no-backup (disposal of the verified gate identity only); release lock
fail: any test failure -> still stop and release; keep the first failure and any cleanup failure separately
risk: never act on a stack whose identity differs from the record; report it instead
```

- The reusable dev stack `retrofit` is never reset by the gate.
- Add `pnpm test:db` to `.rpi/policy.json` after `pnpm test`.

### Evidence analyzer

- `tools/release/analyze-evidence.mjs <candidate-commit>` reads `.rpi/local/verification.json`, `.local/evidence/vitest.json`, `.local/evidence/playwright.json` and `.local/supabase-gate/` records. It rejects:
  - a commit or tree identity that differs from the candidate
  - any required check with a non-zero exit, or missing
  - zero passing tests in any suite
  - a skipped test in a required suite
  - any of the required safety and conformance specs missing or not passed: `e2e/key-panel.spec.ts`, `e2e/origins.spec.ts`, `e2e/analyze-blocked.spec.ts`, `e2e/preview.spec.ts` (unofficial label), `e2e/spec6.spec.ts` (consent before contact), `e2e/conformance.spec.ts`, `e2e/free-path.spec.ts`, `tests/fetch/robots.test.ts`, `tests/fetch/limits.test.ts`
  - a gate database record without a completed teardown
- `tests/release/analyze-evidence.test.ts`: one fixture set per rejection above, and one accepted set.

### Hosting configuration

- `vercel.json`: `"git": {"deploymentEnabled": {"develop": false, "sutura/*": false}}`, `"ignoreCommand": "test \"$VERCEL_ENV\" != \"production\""`, `functions` with `maxDuration` 60 for the analyze, score and inference routes, and the cleanup cron.
- `docs/release/release-playbook.md`: artifact, state, rollback and Wave A commands for this stack. Rollback: `vercel rollback` to the previous production deployment, with owner authorization.
- `docs/development/resource-lifecycle.md`: the dev stack (reusable, start `supabase start`, stop `supabase stop` keeps data, no reset outside an authorized lifecycle) and the gate stack (disposable, managed only by `tools/gate-db.mjs`).

## Tests (write first)

- `tests/store/supabase.test.ts`: the shared contract suite against the gate stack (run by `pnpm test:db`; a missing stack is a failure, never a skip).
- `supabase/tests/store_access.sql`: as `anon` and `authenticated`, select, insert and update on each table are denied; as `service_role` they work; a table created later is not readable by `anon`.
- `tests/store/supabase-failure.test.ts`: an adapter pointed at a closed port makes `/api/health` return `degraded` and analyze return the "having trouble" text; the log has `[TABLE_FALLBACK]`.
- `tests/tools/gate-db-lock.test.ts`: a held lock gives exit 1 naming the holder; a lock with a dead pid is reported and left in place.
- `tests/api/cleanup.test.ts`: wrong or missing `CRON_SECRET` gives 401; expired rows are deleted, live rows kept.
- `tests/release/analyze-evidence.test.ts`: as above.

## External actions (each needs the owner's authorization for that exact action)

Do them in this order. Inspect the target before each and record the result.

1. **Confirm Vercel's function region** for team `thecreativetoken` and choose the Supabase region next to it (`us-east-1` if the region is `iad1`).
2. **Create the Supabase project** `retrofit` in that region.
3. **Apply the migration** with `supabase db push`, after `supabase migration list` against the linked project.
4. **Create the Vercel project** `retrofit` in team `thecreativetoken` without a Git connection.
5. **Set production environment variables**: `SESSION_SECRET` and `CRON_SECRET` (generated locally, never printed), `PUBLIC_ORIGIN` `https://retrofit.thecreativetoken.com`, `OTARI_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `JUDGE_CODE`, cap variables. Production environment only.
6. **Add the domain** `retrofit.thecreativetoken.com` to the project and read the DNS target it asks for.
7. **Create the Route 53 record**: an `UPSERT` change batch in zone `Z05609513HH99AFEUOPD3` with the target from step 6. Show the change batch file to the owner before `aws route53 change-resource-record-sets`, then wait for `aws route53 get-change` to report `INSYNC`.
8. **Release** (playbook steps 1 to 8): merge `develop` into `main` locally with a merge commit; run the full gate on the merge commit; run the evidence analyzer for that commit; present the evidence to the owner; push `main` once (no deployment follows, because Git is not connected); run `vercel deploy --prod` from a clean checkout of that commit.
9. **Connect Git** to the Vercel project so later merges to `main` deploy. Confirm that the production branch is `main`. If the connection starts a deployment, confirm that it is a production deployment of the same commit.

## Post-release verification

- `node tools/agentic-web/scripts/check_partner.mjs https://retrofit.thecreativetoken.com/retrofit_guide` exits 0 with no errors.
- `curl -s https://retrofit.thecreativetoken.com/api/health` returns `ok`.
- Analyze `https://retrofit.thecreativetoken.com/` (Retrofit reads itself, so the smoke test uses no third-party site): score ready, `aw.manifest`, `aw.network-valid` and `aw.cors` pass, and the preview answers one question on the free path.
- `vercel list` for the project shows no deployment with the preview target.
- Inspect every deployment for the pushed commit. On failure, do not rerun or redeploy; report it, reproduce locally and roll back under the playbook if production is affected.

## Automated success criteria

- The full gate passes on the merge commit, including `pnpm test:db`.
- The evidence analyzer accepts the candidate.

## Manual success criteria

- Each external action recorded with its authorization and result.
- Post-release checks recorded.
- `.rpi/release-profile.json`: `hosting-and-domain-decision`, `executable-application-tests`, `candidate-bound-evidence-analyzer`, `third-party-fetch-safety-evidence` and `visitor-key-handling-evidence` move to satisfied with evidence paths. `open-agentic-web-spec-conformance-evidence` records the local §6 evidence and the production partner check, and stays open for the production two-origin demonstration in the second plan.

## Independent work units

- `[batch-eligible]` Unit A: Supabase config, migration, SQL tests, adapter, contract and failure tests.
- `[batch-eligible]` Unit B: gate database tool and its tests.
- `[batch-eligible]` Unit C: evidence analyzer and its tests.
- `[batch-eligible]` Unit D: `vercel.json`, health and cleanup routes, playbook and resource documents.
- External actions are sequential and owned by the integration owner.

## Stuck states in this phase

Store unavailable in production; gate database lock held. See the parent plan table. A failed deploy is handled by the playbook's rollback, never by redeploying to diagnose.

## Exit

Stop for owner acceptance. The next step is the second plan.
