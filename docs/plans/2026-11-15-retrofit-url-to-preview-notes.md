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
