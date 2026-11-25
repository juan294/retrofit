# CI handoff for Sutura

> Historical (2026-11-15 to 2026-11-19). Since then `.github/workflows/ci.yml` exists (Gate and Database), Vercel is set up with a Git connection, and `main` deploys production. Current facts: [the release playbook](../release/release-playbook.md).

Proposed by Retrofit Phase 1, 2026-11-15. Sutura owns CI cadence and routing for the fleet. This repository adds no `.github/workflows/`. This file gives Sutura what it needs to install a workflow; it does not activate anything.

## Facts

- Repository `juan294/retrofit`, public. Integration branch `develop`, production branch `main`.
- Runtime: Node 24, pnpm 12.15.0 (`packageManager` in `package.json`), Chromium from Playwright 1.65.1.
- The local gate is `python3 .rpi/scripts/rpi-verify.py`, which runs `.rpi/policy.json` `verification_checks` in order. The `rpi-installation` check needs `/Users/juan/code/cc-rpi` and is local only; a hosted job skips it.
- `pnpm evidence:begin` refuses a dirty tree. A hosted job runs on a clean checkout, so it passes.
- No secrets are needed. Tests contact loopback hosts only. `RETROFIT_TEST_FIXTURES=1` is set by the Playwright web server and must never be set on Vercel (the configuration refuses it).
- Refreshed 2026-11-19 at `develop` `26f6365`: the gate now has 15 checks (`.rpi/policy.json`). All phases are implemented locally; the local gate passes 15 of 15 and `node tools/release/analyze-evidence.mjs` accepts the candidate (909 required tests).
- `pnpm test:perf` uses the existing build, so it runs after `pnpm build`. `pnpm test:db` (`tools/gate-db.mjs`) needs Docker and the Supabase CLI; it starts a disposable Supabase stack (project id `retrofit-gate`, ports 54730 to 54739) and removes it. On a hosted runner it can be a separate job; its lock lives under `$HOME/Library/Application Support/retrofit/gate-db/`, which is only a directory path on Linux (INFERRED portable, not run on Linux).
- Deployment (CD) is not part of CI. Vercel is not set up yet; Phase 7 creates the project without Git, deploys the first release with the CLI, then connects Git. `vercel.json` disables Git deployments for `develop` and `sutura/*`, and its `ignoreCommand` skips every non-production build, so after Git is connected only `main` deploys and no Preview is built.

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
      - run: pnpm agent:check
      - run: pnpm peer:check
      - run: pnpm typecheck
      - run: pnpm lint
      - run: pnpm test
      - run: pnpm test:coverage
      - run: pnpm build
      - run: pnpm test:perf
      - run: pnpm test:e2e
      - run: pnpm evidence:seal
  db:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@v5
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v5
        with:
          node-version: 24
          cache: pnpm
      - uses: supabase/setup-cli@v1
      - run: pnpm install --frozen-lockfile
      - run: pnpm test:db
```

The `db` job and the action versions are proposals, not run on a hosted runner.

Triggers and cadence are Sutura's decision. The source commit is recorded in the Phase 1 handoff in `docs/plans/2026-11-15-retrofit-url-to-preview-notes.md`.
