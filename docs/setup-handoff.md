# Retrofit setup handoff

Prepared on 2026-11-14 for the next session in `/Users/juan/code/retrofit`.

## Scope and starting point

The owner authorized a dedicated workspace, a GitHub repository, Summon configuration, a briefing document, full native RPI adoption, Archy tracking and local Graphify enrollment. This setup does not include a product plan, application code, a deployment or a release.

The repository is [juan294/retrofit](https://github.com/juan294/retrofit), private at bootstrap. The integration branch is `develop`. No `main` branch exists yet; create it at the first authorized release. Resolve the current setup commit with `git rev-parse develop` and verify the working tree and remote branch when resuming. The first commit, `a26865a08b8f3a9811ff4dd99ce3726b67591924`, holds the license only and is the baseline for the whitespace check.

## Workspace and workflow

- `.summon` selects the `opus-codex` layout. The workspace is registered and trusted locally, and a dry run passed. Launch with `summon retrofit`.
- Claude and Codex native RPI skills were installed with the cc-rpi 2.1.0 direct-route lifecycle engine from clean source commit `dd792f88487bea97a72f5e6240f5b660b62cd250`. The installation check reports healthy with no conflicts.
- Selected domains: shell-tools, git-workflow, multi-agent, deployment-safety, ci-workflow, github-cli, error-patterns, systematic-debugging, macos-rules and webmcp. WebMCP is selected because the product exposes tools to agents. Supabase and Python domain skills are not selected; the universal conditional rule bodies stay installed.
- Shared project instructions are in `AGENTS.md`; `CLAUDE.md` imports them. The [resource contract](development/resource-lifecycle.md) and the [release procedure](release/release-playbook.md) record the present state and the release prerequisites.
- Native skill and hook execution in a fresh agent session has not been observed. A healthy file installation does not prove live harness behavior.

## Tracking

Archy's project registry holds active, monitored Retrofit at path `retrofit`, repository `juan294/retrofit`, project ID `32fc8d02-8a6d-45b9-8017-59d518d23985`. The morning-briefing and portfolio-watchdog project lists include this workspace. Schedules and CI routing are unchanged. The Archy change is local commit `95e82c9` on `develop`, not pushed.

Local Graphify uses this repository's own `graphify-out` link. Web graph publication is disabled and review publication is local-only. The first generation was built with semantic extraction on 2026-11-14 (run `2026-11-14t04-32-54-304z-8efc7c`, 1,362 nodes, 2,735 edges); 17 of 122 files stayed pending and are retried by the fleet. Most nodes come from the installed skill and rule documents, because there is no application code.

The Graphify runtime daemon detected the registry change and refuses semantic jobs until it is restarted. The restart was not done in the setup session. Run it when no extraction is in progress:

```sh
launchctl kickstart -k gui/$(id -u)/com.archy.graphify-runtime
```

## Verification and retained evidence

`python3 .rpi/scripts/rpi-verify.py` runs the declared suite: whitespace against the baseline commit and the RPI installation check. There is no application test suite. No server, database, Docker stack or task service was started.

Local evidence is ignored by Git:

- `.rpi/local/plans/2026-11-14-install.json`: the reviewed install plan.
- `.rpi/local/transactions/`: the lifecycle journal and recovery bytes.
- `.local/setup/summon-dry-run.txt`: the workspace launch preview.
- `.local/setup/graphify-out-prelink/`: a 32 KB cache directory that the first Graphify refresh wrote into the repository before the link existed. It was moved here so the link could be created. It is safe to remove after review.

## Open items for the owner

- The name stays Retrofit (owner decision, 2026-11-14): publishing under a `thecreativetoken.com` subdomain removes the domain constraint. No trademark search was done. Retrofit is also a well-known open-source HTTP client from Square (recalled from memory, not checked).
- The repository is private. The hackathon requires open source, so it must become public before submission.
- The license is Apache-2.0, chosen to match the specification repository. The organizers have not stated which license they expect.
- The expected address is `retrofit.thecreativetoken.com`. No DNS record or deployment exists.
- No local development port is reserved, because the stack is not decided.

## Next session

Start `/rpi-brainstorm` or `/rpi-plan` in Claude, or the `$` form in Codex, in this workspace. Read the [briefing](briefing.md) and the [design brief](research/2026-11-14-retrofit-brief.md), and verify the actual refs and setup evidence. Read the open agentic web specification end to end before choosing a stack. Plan the path from URL to live preview first. Stop after the reviewed plan. Setup approval does not authorize implementation, deployment, domain changes, a visibility change or a Devpost submission.
