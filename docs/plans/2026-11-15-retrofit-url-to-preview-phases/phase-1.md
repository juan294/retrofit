# Phase 1: Scaffold, configuration, vendored runtime and local gate

Parent plan: [2026-11-15-retrofit-url-to-preview.md](../2026-11-15-retrofit-url-to-preview.md).

## Goal

A Next.js 16 application that builds and serves a landing page with a strict CSP, a configuration module with every limit the later phases use, the organizers' runtime vendored unchanged with a checksum manifest, and a local gate in `.rpi/policy.json` that runs every check. The stack decision is recorded. The proposed CI workflow goes to Sutura as a handoff.

## Entry conditions

- Owner accepted the plan.
- Work in a worktree on a local branch from `develop`. No push.
- Node 24 and pnpm 10 installed (`node --version`, `pnpm --version`).

## Changes

### 1. Application scaffold

- `package.json`: `"packageManager"` with the exact pnpm 10 version at install, `"engines": {"node": "24.x"}`, scripts:
  - `dev`: `next dev --port 3009`
  - `build`; `start`: `next start --port 3010`
  - `typecheck`: `tsc --noEmit`; `lint`: `eslint .`
  - `test`: `vitest run`; `test:coverage`: `vitest run --coverage`
  - `test:e2e`: `playwright test`
  - `vendor:sync`, `vendor:verify`
- `tsconfig.json` (strict), `eslint.config.mjs` (includes `react/no-danger` as an error), `vitest.config.mts`, `playwright.config.ts` (web server `pnpm build && RETROFIT_TEST_FIXTURES=1 pnpm start`, port 3010, Chromium only, JSON reporter to `.local/evidence/playwright.json`), `next.config.ts`, Tailwind 4.
- `src/app/layout.tsx`, `src/app/page.tsx`: landing page with `<h1>Retrofit</h1>` and the lead line "An agent on your own website that can take the order, and it is yours to keep." The URL form arrives in Phase 3.
- Neutral design tokens as CSS variables in `src/app/globals.css`, with light and dark values.

### 2. Configuration module

`src/lib/config.ts` reads server environment variables once.

| Variable | Default | Used in |
| --- | --- | --- |
| `CRAWL_MAX_PAGES` | 12 | Phase 2 |
| `FETCH_TIMEOUT_MS` | 8000 | Phase 2 |
| `FETCH_MAX_BYTES` | 2097152 | Phase 2 |
| `CRAWL_BUDGET_MS` | 45000 | Phase 2 |
| `HOST_LOCK_TTL_S` | 60 | Phase 2 |
| `SNAPSHOT_CACHE_TTL_S` | 86400 (cache index from origin to record) | Phase 2, 3 |
| `ANALYSES_PER_CLIENT_HOUR` | 20 | Phase 3 |
| `STALE_AFTER_S` | 90 | Phase 3 |
| `RECORD_TTL_S` | 604800 (record and its snapshot) | Phase 3 |
| `PUBLIC_ORIGIN` | `http://127.0.0.1:3010` outside Vercel; required on Vercel | Phases 4, 5 |
| `SESSION_SECRET` | random per process outside Vercel, with a warning; required on Vercel | Phases 3, 5 |
| `RETROFIT_TEST_FIXTURES` | unset | Phases 2 to 4 |

```
@ loadConfig(env) -> Config
pre: called on the server only
do:
  1. parse numeric values with defaults; reject non-positive numbers
  2. validate HOST_LOCK_TTL_S < STALE_AFTER_S (so Retry after a stale failure can start a new crawl)
  3. detect Vercel when VERCEL or VERCEL_ENV is set
  4. validate SESSION_SECRET (32 bytes or more) and PUBLIC_ORIGIN are set on Vercel
  5. validate RETROFIT_TEST_FIXTURES is unset on Vercel
  6. emit frozen Config with fixturesEnabled
fail: any rule broken -> throw ConfigError naming the variable
```

`fixturesEnabled` lets the fetch guard accept loopback addresses and enables test-only fixture routes. It does not depend on `NODE_ENV`, because `next start` runs in production mode.

### 3. Security headers

- Pages: nonce-based CSP `default-src 'self'; script-src 'self' 'nonce-<n>' 'strict-dynamic'; style-src 'self' 'nonce-<n>'; connect-src 'self'` plus the provider router origins added in Phase 4; `frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'`.
- `/bridge/*` and `/p/*/bridge/*`: `script-src 'self'; frame-ancestors *` (the static bridge loads its script without a nonce).
- `/runtime/sandbox-worker.js`: `default-src 'none'; script-src blob:; connect-src 'none'; worker-src 'none'`.
- All responses: `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy: camera=(), microphone=(), geolocation=()`.
- Confirm against the installed Next.js version whether the request hook file is `src/proxy.ts` or `src/middleware.ts`, and record the answer in the decision record.

### 4. Vendored runtime

- `tools/vendor-agentic-web.mjs sync --source <clone> --commit 63a956cf4653f610b1c238c70946f4d7647d17a8`:
  - refuses unless the clone's `HEAD` equals the commit
  - copies `skills/agentify-website/runtime/` to `public/runtime/` and to `tools/agentic-web/runtime/` (the oracle scripts import `../runtime/*`)
  - copies `skills/agentify-website/scripts/` and `skills/agentify-website/templates/` to `tools/agentic-web/`
  - copies `templates/content-actions.js` and `templates/bridge/` to `public/preview-assets/`
  - writes `vendor/agentic-web.json`: source repository, commit, date and the SHA-256 of every copied file
- `tools/vendor-agentic-web.mjs verify` recomputes each hash and exits 1 with the list of changed, missing and extra files.
- The clone lives in ignored `.local/vendor/agentic-web`. Never run scripts from the clone itself.
- Add `NOTICE` entries for the vendored Apache-2.0 files.

### 5. Records and documentation

- `docs/decisions/2026-11-15-stack-and-hosting.md`: owner decisions, planner decisions and reasons from the parent plan, including the single-origin deviation.
- `AGENTS.md` "Stack and agent surface": the stack, package manager, test tools, ports and gate. Keep the rest.
- `.rpi/policy.json` `verification_checks`, each a separate entry, in order: whitespace, rpi-installation, `pnpm vendor:verify`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`, `pnpm test:e2e`.
- `.rpi/release-profile.json`: `stage` to `build`; remove `no-stack-decision` from `current_gaps`.
- `docs/development/resource-lifecycle.md`: ports 3009, 3010 and 3011; Supabase blocks 54720 to 54729 (reusable dev) and 54730 to 54739 (disposable gate) reserved for Phase 6; start and stop commands for the dev and test servers.
- `/Users/juan/code/archy/docs/local-development-ports.md`: rows for 3009, 3010 and 3011. Check that the Archy working tree is clean, make the change on a new local branch from Archy's integration branch, commit locally, do not push, and report the branch and commit.
- `docs/development/ci-handoff.md`: the proposed GitHub Actions workflow for Sutura (the same gate on Node 24 with pnpm and Chromium), its triggers, and the facts Sutura needs (repository, source commit, gate command). Do not add `.github/workflows/`.

## Tests (write first)

- `tests/config.test.ts`: defaults; a bad number names the variable; `HOST_LOCK_TTL_S >= STALE_AFTER_S` refused; on Vercel, missing `SESSION_SECRET` or `PUBLIC_ORIGIN` refused; `RETROFIT_TEST_FIXTURES` refused when `VERCEL` is set and when `VERCEL_ENV` is set; accepted with `NODE_ENV=production` off Vercel.
- `tests/vendor/verify.test.ts`: a fixture tree with a manifest; change one byte, add one file, remove one file; `verify` exits 1 and names all three.
- `e2e/landing.spec.ts`: `GET /` returns 200 and shows the heading; `script-src` has a nonce and no host source other than `'self'`; no response on the page loads a script from another origin; `X-Content-Type-Options` is `nosniff`.

## Automated success criteria

- `python3 .rpi/scripts/rpi-verify.py` passes with all checks above. Each test check reports a non-zero count.
- `pnpm vendor:verify` passes on the committed tree and fails on the tamper fixture.
- Coverage from `pnpm test:coverage` is reported in the phase handoff (no threshold yet).

## Manual success criteria

- The owner accepts the decision record.
- The CI handoff text goes to the owner for Sutura, with the exact source commit.
- The Archy port edit is reported with its branch and commit.

## Independent work units

- `[batch-eligible]` Unit A: scaffold, configuration, security headers (`package.json`, `src/`, configs, `tests/config.test.ts`, `e2e/landing.spec.ts`).
- `[batch-eligible]` Unit B: vendor tool and vendored files (`tools/vendor-agentic-web.mjs`, `tools/agentic-web/`, `public/runtime/`, `public/preview-assets/`, `vendor/`, `NOTICE`, `tests/vendor/`). The integration owner runs its test after Unit A provides Vitest.
- Unit C (integration owner, after A and B): documentation, policy, release profile, CI handoff, Archy edit.

## Stuck states in this phase

Vendored runtime damaged. See the parent plan table.

## Exit

Stop for owner acceptance. Record the tested commit, gate output and coverage in the phase handoff.
