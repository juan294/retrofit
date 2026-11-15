# Retrofit local resources

## Current footprint

Retrofit is a Next.js application. Its local services are loopback processes on reserved ports (Archy `docs/local-development-ports.md`). It has no Docker stack until Phase 7 adds the Supabase blocks below.

The canonical workspace is `/Users/juan/code/retrofit`. Parallel code tasks use isolated worktrees. A worktree does not isolate a database, a local port, browser storage or a provider account. Two worktrees cannot run the Playwright gate at the same time, because both use port 3010.

| Port | Process | Start | Stop | Owner |
| ---: | --- | --- | --- | --- |
| 3009 | `next dev` | `pnpm dev` | Ctrl-C, or stop the recorded pid | The developer task that started it |
| 3010 | `next start` for Playwright | Started and stopped by `pnpm test:e2e` (`playwright.config.ts` `webServer`, `reuseExistingServer: false`) | Playwright stops it at the end of the run | The gate run |
| 3011, 3013 | Loopback fixture servers (test peer origins) | Started inside the test that needs them | Closed by the same test | The test |
| 3012 | Phase 5 merchant spike server | Record the pid before start | Stop that pid at the end of the spike | The spike task |
| 3014 | `next start` for `pnpm test:perf` | Vitest `perf` global setup, from the existing build | The same setup stops its recorded pid at teardown | The gate run |

If a port is busy before a run, find its pid (`lsof -nP -iTCP:<port> -sTCP:LISTEN`) and verify the owner before you stop anything. Do not stop a process that another task started.

Supabase:

| Stack | Project id | Ports | Start | Stop | Data |
| --- | --- | --- | --- | --- | --- |
| Reusable dev stack | `retrofit` | 54720 to 54729 | `supabase start` in the canonical checkout | `supabase stop` (keeps data) | Kept between tasks. Never reset by the gate. |
| Disposable gate stack | `retrofit-gate` | 54730 to 54739 | `pnpm test:db` (`tools/gate-db.mjs`), config generated into `.local/supabase-gate/` | The same command: `supabase stop --no-backup` after identity checks | Removed at the end of every run. |

`pnpm test:db` takes a machine-wide lock and writes a receipt in `~/Library/Application Support/retrofit/gate-db/` before it starts anything. It refuses when a `retrofit-gate` container, volume or network exists without its own receipt, and never resets or removes such resources. A run that dies leaves its receipt; `pnpm gate-db:recover` disposes the stack only when the receipt's process is dead and every resource matches it, and otherwise reports and leaves everything in place. Each run logs to `.local/evidence/current/gate-db.log`, ending with `GATE-DB TEARDOWN COMPLETE` only after verified removal. Only one worktree can run the gate database at a time.

## Resource classes

| Resource | Class | Owner and lifecycle |
| --- | --- | --- |
| `.rpi/local/` | Recovery and evidence | Retrofit setup task. Keep through handoff and review. Never prune as a disposable cache. |
| `.local/` | Task evidence | The task that writes it. Record the owner and the intended disposal before writing. |
| Package manager caches | Shared reusable | The package tooling. Preserve. Do not clean globally to fix a local problem. |
| Fetched copies of third-party sites | Sensitive task data | Keep in an ignored task directory. Never commit, index or publish them. |
| Visitor LLM keys and test keys | Secret | Never written to the repository, logs or evidence. Use test keys from an ignored `.env` file only. |
| Archy Graphify service and indexes | Fleet owned | Archy. Not a Retrofit task service. |

## Task completion

Report stopped processes, retained resources, their owner and the next review action. Destructive cleanup needs authorization for that exact scope. Never use machine-wide pruning as routine cleanup.
