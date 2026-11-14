# Retrofit local resources

## Current footprint

Retrofit has no application code at bootstrap. It has no Docker stack, database, server port, remote development service or cleanup daemon. Do not allocate these to run the repository checks.

The canonical workspace is `/Users/juan/code/retrofit`. Parallel code tasks use isolated worktrees. A worktree does not isolate a database, a local port, browser storage or a provider account.

## Resource classes

| Resource | Class | Owner and lifecycle |
| --- | --- | --- |
| `.rpi/local/` | Recovery and evidence | Retrofit setup task. Keep through handoff and review. Never prune as a disposable cache. |
| `.local/` | Task evidence | The task that writes it. Record the owner and the intended disposal before writing. |
| Package manager caches | Shared reusable | The package tooling. Preserve. Do not clean globally to fix a local problem. |
| Fetched copies of third-party sites | Sensitive task data | Keep in an ignored task directory. Never commit, index or publish them. |
| Visitor LLM keys and test keys | Secret | Never written to the repository, logs or evidence. Use test keys from an ignored `.env` file only. |
| Archy Graphify service and indexes | Fleet owned | Archy. Not a Retrofit task service. |

## Before the first service

The product plan must decide the stack, the local port and any database. When it does:

1. Reserve the port in Archy's `docs/local-development-ports.md` and fix it in the development command. Port 3000 stays unassigned.
2. Give each concurrent mutable task its own project identity.
3. Document the start, stop and reset commands here, with the data that each command keeps and removes.
4. Record exact process IDs, ports and directories before a task starts a service, and stop only the verified task-owned process.

## Task completion

Report stopped processes, retained resources, their owner and the next review action. Destructive cleanup needs authorization for that exact scope. Never use machine-wide pruning as routine cleanup.
