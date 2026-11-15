# CI handoff for Sutura

Proposed by Retrofit Phase 1, 2026-11-15. Sutura owns CI cadence and routing for the fleet. This repository adds no `.github/workflows/`. This file gives Sutura what it needs to install a workflow; it does not activate anything.

## Facts

- Repository `juan294/retrofit`, public. Integration branch `develop`, production branch `main`.
- Runtime: Node 24, pnpm 12.15.0 (`packageManager` in `package.json`), Chromium from Playwright 1.65.1.
- The local gate is `python3 .rpi/scripts/rpi-verify.py`, which runs `.rpi/policy.json` `verification_checks` in order. The `rpi-installation` check needs `/Users/juan/code/cc-rpi` and is local only; a hosted job skips it.
- `pnpm evidence:begin` refuses a dirty tree. A hosted job runs on a clean checkout, so it passes.
- No secrets are needed. Tests contact loopback hosts only. `RETROFIT_TEST_FIXTURES=1` is set by the Playwright web server and must never be set on Vercel (the configuration refuses it).
- Later phases add `pnpm agent:check` (Phase 4), `pnpm test:perf` (Phase 3) and `pnpm test:db` (Phase 7, needs Docker and the Supabase CLI; propose it as local-only or as a separate job).

## Proposed workflow

```yaml
name: gate
on:
  pull_request:
    branches: [develop, main]
  push:
    branches: [develop, main]
permissions:
  contents: read
jobs:
  gate:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v5
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v5
        with:
          node-version: 24
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm exec playwright install --with-deps chromium
      - run: pnpm evidence:begin
      - run: pnpm vendor:verify
      - run: pnpm typecheck
      - run: pnpm lint
      - run: pnpm test
      - run: pnpm test:coverage
      - run: pnpm build
      - run: pnpm test:e2e
      - run: pnpm evidence:seal
```

Triggers and cadence are Sutura's decision. The source commit is recorded in the Phase 1 handoff in `docs/plans/2026-11-15-retrofit-url-to-preview-notes.md`.
