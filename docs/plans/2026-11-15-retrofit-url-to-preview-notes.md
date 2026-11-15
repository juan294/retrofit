# Notes: Retrofit, from URL to live preview

Implementation notes for the plan `2026-11-15-retrofit-url-to-preview.md` and its phase files. Implementation ran on 2026-11-15 under the owner's instruction "all phases, no stopping, when you're done merge to develop and prune your tree(s)". That instruction continues past phase acceptance gates. It does not authorize a push, deployment, provider account, credential, DNS change or any other external action; those stay listed as pending.

- Worktree: `/Users/juan/code/retrofit-worktrees/url-to-preview`, branch `feat/url-to-preview`, from `develop` at `10d7eca`.
- Specification: `cognizant-ai-labs/agentic-web` at `63a956cf4653f610b1c238c70946f4d7647d17a8` (unchanged at Phase 1 entry, `git ls-remote` on 2026-11-15).
- Overlay: `.rpi/project/rpi-implement.md` is absent. No declared override applied.

## Deviations

| Phase | Plan said | Found | Chose | Why |
| --- | --- | --- | --- | --- |
| 1 | pnpm 10 | pnpm 12.15.0 is installed | `packageManager: pnpm@12.15.0` | Routine tool version; no plan behavior depends on pnpm 10. |
| 1 | Coverage summary at `.local/evidence/current/coverage-summary.json` | Vitest coverage cleans its report directory before each run, which would delete the other reports | Summary at `.local/evidence/current/coverage/coverage-summary.json` | Keeps the attempt's other reports intact. |
| 1 | Archy port edit after checking the Archy tree is clean | Archy's `develop` checkout has uncommitted operational reports | Separate Archy worktree on branch `chore/retrofit-ports` from `develop` (`6341360`) | Leaves the owner's uncommitted Archy changes untouched. |
| 1 | `next build` (implied: same tsconfig) | `next build` type-checks every file in `tsconfig.json`, including tests | `tsconfig.build.json` limited to `src/` for the build; `pnpm typecheck` still checks tests | Build failures stay about the application. |
| 1 | Vendored files pass the whitespace check | `generated/agent-runner.bundle.js` has trailing whitespace upstream | `.gitattributes` `-whitespace` for the three vendored roots | Vendored files stay unchanged; `vendor:verify` checks them instead. |
| 2 | `tldts` latest | pnpm 12's minimum-release-age policy rejected `tldts` 7.5.3 (published 2026-11-14) and wrote an exclusion into `pnpm-workspace.yaml` | Pinned `tldts` 7.4.28; removed the exclusion | Keeps the supply-chain policy intact. |
| 2 | Email scrubbing (no limit stated) | An unbounded email pattern took quadratic time on the hostile 5 MB page and blocked the worker | Bounded repetitions in the pattern, plus an `@` pre-check; timing test in `tests/fetch/extract.test.ts` | A hostile page must not stall a crawl. |
| 2 | Store keys `crawl:<inputOrigin>` and `crawl:<destinationHost>` | Origins and hosts share one key space | `crawl:origin:<origin>` and `crawl:dest:<host>` | Avoids a collision between an origin and a host string. |
| 2 | Stale rule reads the lease | The Store contract has no lease read | The worker records `leaseExpiresAt` on the job at each renewal; the stale check reads it | Same rule, one store read. |
| 2 | Pacing interval `max(1 s, crawl delay)` with no upper bound | A large `Crawl-delay` would make the worker sleep past its 60 s lease | Waits are capped at `MAX_CRAWL_DELAY_S` (10 s). Above it Retrofit reads only robots.txt and the home page, 10 s apart; skipped pages carry reason `crawl-delay` | Honours the site's request without losing the lease; the visitor still gets a score from the home page. |

## Phase 1 handoff

- Scope: all Phase 1 changes. Commits `f7e9c9c` (implementation) and `170cdd9` (review fixes).
- Gate on `f7e9c9c` (`python3 .rpi/scripts/rpi-verify.py`, 2026-11-15): every check passed except `rpi-installation`, which exits 2 with "installation needs reconciliation". The same check fails on `develop` at `10d7eca` with no Retrofit change: the `cc-rpi` source moved to 2.2.0 (`0d0213e`, 2026-11-15 07:40) after this repository's install. Updating the RPI install is a fleet tooling action outside this plan; it stays open for the owner. Unit tests 46, coverage 92.95% statements and 98.24% branches, e2e 4.
- Independent review (fresh context) found P1-R1 to R11 and P1-M1 to M3. Dispositions:
  - Fixed in `170cdd9`: R1 (CSP now on every non-asset response, including unknown paths), R2 (dynamic root layout, so not-found pages carry the nonce; e2e case added), R3 and R4 (exact-list CSP evaluation in `e2e/fixtures/csp-eval.ts` with unit tests; console CSP errors always checked), R5 (sync refuses a dirty clone), R6 (broader import rule), R7 (test uses the proxy's composition), R8 (negative cases assert the collected violations first, so only the fixture can fail them), R9 (script-execution marker), R10 (release profile gaps), R11 (lint rule: specs must import the CSP fixture).
  - Kept by design: prefetch requests skip the request hook. They return RSC payloads, not documents (Next.js CSP guide).
  - M1: `tests/perf/global-setup.ts` arrives in Phase 3 with the perf test. M2: real router navigation is tested in Phase 3, when the landing page links to `/bot`. M3: this handoff.
- Archy port rows: worktree `/Users/juan/code/retrofit-worktrees/archy-retrofit-ports`, branch `chore/retrofit-ports`, commit `00e43fc`, local only, not pushed.
- CI handoff for Sutura: `docs/development/ci-handoff.md` at source commit `170cdd9`.
- Owner acceptance items: the decision record. Pending; the run continued under the all-phases instruction.

## Phase 2 handoff

- Scope: all Phase 2 changes. Commits `49f9f1e` (implementation) and the repair commit after it.
- Gate on `49f9f1e`: every check passed except `whitespace` (one blank line at the end of `tests/fetch/extract.test.ts`, fixed in the repair commit) and `rpi-installation` (pre-existing, see Phase 1). Unit tests 295, coverage 93.27% statements and 85.33% branches, e2e 5.
- Independent review (fresh context) found no S1 or S2 defect. Dispositions:
  - P2-R1 (S3, alias written before its job, so a slow store could start two crawls): fixed; the job is written first and an orphan is deleted. `tests/crawl/jobs.test.ts` interleaves store operations at random (`tests/helpers/jitter-store.ts`); the test fails on `49f9f1e` and passes now.
  - P2-R2 (S3, probes without lease renewal; unbounded crawl delay): fixed; a progress step (lease renewal) precedes every probe and page; budget checked before each probe; crawl delay above 10 s limits the crawl (deviation row above).
  - P2-R3 (S3, extractor output the validator refused): fixed; URLs over 4096 characters dropped, JSON-LD cut one level above the validator limit, record ids and types clipped. Test builds and validates a snapshot from hostile markup.
  - P2-R4 (S3, emails in probe bodies and percent-encoded emails): fixed; probe bodies scrubbed; the pattern accepts `%40`.
  - P2-R5 (S4, destination claim before the lease check): fixed; the worker renews first.
  - P2-R6 (S4, request after robots.txt ignored the crawl delay): fixed; robots reserves the next slot with the delay.
  - P2-R7 (S4, redirect to a private path extracted): fixed; the landing path is checked.
  - P2-R8 (S4, `busy` skipped `onFinish`): fixed; `onFinish` runs on every outcome.
  - P2-R9 (S4, tests): the rebinding test's first answer is loopback; the hostile test now walks the snapshot and requires every injection hit to be a data field.
- Plan items moved: `src/lib/fetch/limits.ts` (listed as a Phase 2 Store consumer) arrives in Phase 3 with the client limits that use it. "Robots and probe requests are paced" is tested in `tests/fetch/crawl.test.ts`, `tests/fetch/http.test.ts` and `tests/fetch/robots.test.ts`, not `tests/fetch/pacing.test.ts`. The `spaOnly` and `agentified` fixtures are first used by the Phase 3 golden scores.
- Plan gap for Phase 7: the SQL function list omits the queue operations (`enqueue`, `claimNext`) that the shared contract suite requires; Phase 7 adds them.
- Re-review of `7f84253` (same reviewer): R1, R3, R4, R5, R7, R8, R9 closed with evidence. R2 and R6 partly closed, plus P2-N1 (S3, the robots slot reservation made the home request wait the full crawl delay, up to 60 s, before the lease was renewed), P2-N2 (S4, kept header values not clipped) and P2-N3 (S4, a deviation row outside the table). Fixed in the next commit: every wait is capped at `MAX_CRAWL_DELAY_S` (10 s) in `http.ts` and `robots.ts`; the robots.txt probe goes through `guardedFetch`, so it waits the delay too; header values are clipped to 1024 characters; the row is in the table. Residual risk (S4, accepted for owner review): a redirect chain across several hosts that each set a long crawl delay can still take up to five capped waits before the next lease renewal; the 60 s lease covers four.
