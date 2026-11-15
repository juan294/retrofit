# Phase 1: Scaffold, configuration, CSP, vendored runtime and gate

Parent plan: [2026-11-15-retrofit-url-to-preview.md](../2026-11-15-retrofit-url-to-preview.md).

## Goal

A Next.js 16 application with a strict CSP on a first-party-only origin, a configuration module with every limit the later phases use, the organizers' runtime vendored unchanged with a checksum manifest, and a local gate whose test reports are bound to one attempt. The stack decision is recorded. The proposed CI workflow goes to Sutura as a handoff.

## Entry conditions

- Owner accepted the plan.
- Work in a worktree on a local branch from `develop`. No push.
- Node 24 and pnpm 10 installed.

## Changes

### 1. Application scaffold

- `package.json`: exact `packageManager` (pnpm 10), `"engines": {"node": "24.x"}`, scripts:
  - `dev`: `next dev --port 3009`; `build`; `start`: `next start --port 3010`
  - `typecheck`: `tsc --noEmit`; `lint`: `eslint .`
  - `test`: `vitest run --project unit --reporter=default --reporter=json --outputFile.json=.local/evidence/current/vitest-unit.json`
  - `test:coverage`: unit project with coverage, summary to `.local/evidence/current/coverage-summary.json`, thresholds statements 80% and branches 70% for `src/lib/**`
  - `test:db`: added in Phase 7
  - `test:e2e`: `playwright test` with the JSON reporter to `.local/evidence/current/playwright.json`
  - `vendor:sync`, `vendor:verify`, `evidence:begin`, `evidence:seal`
- `vitest.config.mts` with projects `unit` (everything except `tests/db/**`) and `db` (`tests/db/**`, Phase 7). A `db` test outside `tests/db/` fails lint (a custom ESLint rule on imports of the Supabase adapter in `tests/` outside `tests/db/`).
- `tsconfig.json` (strict), `eslint.config.mjs` (`react/no-danger` as an error), `playwright.config.ts` (web server `pnpm build && RETROFIT_TEST_FIXTURES=1 pnpm start`, port 3010, Chromium), `next.config.ts`, Tailwind 4.
- `e2e/fixtures/csp.ts`: a Playwright fixture used by every spec. It listens for `securitypolicyviolation` events and console CSP errors and fails the test on any.
- `src/app/layout.tsx`, `src/app/page.tsx`: `<h1>Retrofit</h1>` and the lead line "An agent on your own website that can take the order, and it is yours to keep." The URL form arrives in Phase 3. Pages render dynamically so that each response has its own nonce.
- Neutral design tokens as CSS variables with light and dark values.

### 2. Configuration module

`src/lib/config.ts` reads server environment variables once.

| Variable | Default | Used in |
| --- | --- | --- |
| `CRAWL_MAX_PAGES` | 12 | 2 |
| `FETCH_TIMEOUT_MS` | 8000 | 2 |
| `FETCH_MAX_BYTES` | 2097152 | 2 |
| `CRAWL_BUDGET_MS` | 45000 | 2 |
| `CRAWL_LEASE_TTL_S` | 60 | 2 |
| `CRAWL_CACHE_TTL_S` | 86400 | 2, 3 |
| `CRAWL_MAX_CONCURRENT` | 8 | 3 |
| `CRAWL_MAX_HOSTS_PER_DAY` | 1000 | 3 |
| `ANALYSES_PER_CLIENT_HOUR` | 20 | 3 |
| `STALE_AFTER_S` | 90 | 3 |
| `ANALYSIS_TTL_S` | 604800 | 3 |
| `SCORE_WAIT_MS` | 25000 | 3 |
| `PUBLIC_ORIGIN` | `http://127.0.0.1:3010` off Vercel; required on Vercel | 3, 4, 6 |
| `SESSION_SECRET` | random per process off Vercel, with a warning; required on Vercel (32 bytes or more) | 3, 6 |
| `RETROFIT_TEST_FIXTURES` | unset | 2, 3, 4, 5 |

```
@ loadConfig(env) -> Config
pre: called on the server only
do:
  1. parse numbers with defaults; reject non-positive values
  2. validate CRAWL_LEASE_TTL_S < STALE_AFTER_S and CRAWL_BUDGET_MS < CRAWL_LEASE_TTL_S * 1000
  3. detect Vercel when VERCEL or VERCEL_ENV is set
  4. validate SESSION_SECRET and PUBLIC_ORIGIN on Vercel; RETROFIT_TEST_FIXTURES unset on Vercel
  5. emit frozen Config with fixturesEnabled
fail: any rule broken -> throw ConfigError naming the variable
```

`fixturesEnabled` does not depend on `NODE_ENV`, because `next start` runs in production mode.

### 3. Security headers

- Pages: `default-src 'self'; script-src 'self' 'nonce-<n>'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'` plus exact origins added in later phases; `frame-src 'self'`; `frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'`.
  - No `'strict-dynamic'`: a script loaded by another script must still come from `'self'`.
  - `style-src` allows inline styles because the unchanged runtime inserts a `<style>` element and inline style attributes (parent plan, fact 9). Scripts stay nonce-only.
- `/bridge/*` and `/p/*/bridge/*`: `script-src 'self'; frame-ancestors *`.
- `/runtime/sandbox-worker.js`: `default-src 'none'; script-src blob:; connect-src 'none'; worker-src 'none'`.
- All responses: `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy: camera=(), microphone=(), geolocation=()`.
- Pages with a nonce send `Cache-Control: private, no-store`.
- `connect-src` is built by one function, `buildConnectSrc(config, phaseOrigins)`, so later phases add origins in one place.
- Confirm against the installed Next.js version whether the request hook is `src/proxy.ts` or `src/middleware.ts`, and record it.

### 4. Vendored runtime

- `tools/vendor-agentic-web.mjs sync --source <clone> --commit 63a956cf4653f610b1c238c70946f4d7647d17a8`:
  - refuses unless the clone's `HEAD` equals the commit
  - copies `skills/agentify-website/runtime/` to `public/runtime/` and `tools/agentic-web/runtime/`
  - copies `skills/agentify-website/scripts/` and `templates/` to `tools/agentic-web/`
  - copies `templates/content-actions.js` and `templates/bridge/` to `public/preview-assets/`
  - writes `vendor/agentic-web.json` with the source, commit, date and SHA-256 of every file
- `verify` recomputes the hashes and exits 1 with the changed, missing and extra files.
- The clone lives in ignored `.local/vendor/agentic-web`. Never run scripts from the clone itself.
- `NOTICE` entries for the vendored Apache-2.0 files.

### 5. Evidence binding

- `tools/evidence.mjs begin`: refuses a dirty working tree; deletes `.local/evidence/current/`; writes `attempt.json` with a random nonce, the commit, `git rev-parse HEAD^{tree}` and the start time.
- `tools/evidence.mjs seal`: records the SHA-256, size and modification time of every report in `current/` into `attempt.json`, and refuses if a report is older than `begin`.

### 6. Records and documentation

- `docs/decisions/2026-11-15-stack-and-hosting.md`: owner and planner decisions with reasons.
- `AGENTS.md` "Stack and agent surface": stack, package manager, test tools, ports, gate.
- `.rpi/policy.json` `verification_checks`, each a separate entry, in order: whitespace, rpi-installation, `pnpm evidence:begin`, `pnpm vendor:verify`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm test:coverage`, `pnpm build`, `pnpm test:e2e`, `pnpm evidence:seal`. Later phases insert their checks before `evidence:seal`.
- `.rpi/release-profile.json`: `stage` to `build`; remove `no-stack-decision` from `current_gaps`.
- `docs/development/resource-lifecycle.md`: ports 3009 to 3012, the Supabase blocks for Phase 7, start and stop commands for dev and test servers.
- Archy port list `/Users/juan/code/archy/docs/local-development-ports.md`: rows for 3009 to 3012. Check that the Archy tree is clean, use a new local branch from Archy's integration branch, commit locally, no push, report branch and commit.
- `docs/development/ci-handoff.md`: the proposed GitHub Actions workflow for Sutura (the same gate on Node 24, pnpm and Chromium), its triggers and the facts Sutura needs. No `.github/workflows/`.

## Tests (write first)

- `tests/config.test.ts`: defaults; a bad number names the variable; lease and stale ordering enforced; on Vercel, missing `SESSION_SECRET` or `PUBLIC_ORIGIN` refused; `RETROFIT_TEST_FIXTURES` refused when `VERCEL` or `VERCEL_ENV` is set; accepted with `NODE_ENV=production` off Vercel.
- `tests/security/csp.test.ts`: the production header has no host source other than `'self'` in `script-src`, no `'strict-dynamic'`, and no fixture origin; the fixtures header adds only the exact fixture origins.
- `tests/vendor/verify.test.ts`: tamper fixture (one changed, one added, one removed file) gives exit 1 naming all three.
- `tests/tools/evidence.test.ts`: `begin` refuses a dirty tree; `seal` refuses a report older than `begin`; `begin` removes earlier reports.
- `e2e/landing.spec.ts` (with the CSP fixture): `GET /` shows the heading; two responses carry different nonces; client navigation and hydration produce no violations; no request goes to another origin; `X-Content-Type-Options` is `nosniff`.

## Automated success criteria

- `python3 .rpi/scripts/rpi-verify.py` passes with all checks above, each test check with a non-zero count, coverage above the bar.
- `pnpm vendor:verify` passes on the committed tree and fails on the tamper fixture.

## Manual success criteria

- The owner accepts the decision record.
- The CI handoff text goes to the owner for Sutura, with the exact source commit.
- The Archy port edit is reported with its branch and commit.

## Independent work units

- `[batch-eligible]` Unit A: scaffold, configuration, security headers and their tests.
- `[batch-eligible]` Unit B: vendor tool and vendored files, `tests/vendor/`.
- `[batch-eligible]` Unit C: evidence tool and its tests.
- Unit D (integration owner, after A to C): documentation, policy, release profile, CI handoff, Archy edit.

## Stuck states in this phase

Vendored runtime changed; evidence stale. See the parent plan table.

## Exit

Stop for owner acceptance. Record the tested commit, gate output and coverage in the phase handoff.
