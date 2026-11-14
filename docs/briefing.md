# Retrofit: project briefing

> Created 2026-11-14. Read this before planning or changing the project.

## Purpose and accepted decisions

Retrofit turns an existing website into an agentic website without a rebuild. A visitor pastes a public URL. Retrofit scores the site, builds a working agent for it that runs in the browser, gives a plan and a file bundle, and offers a done-for-you service.

Retrofit is Juan's entry for the Open Agentic Web Challenge (Cognizant, on Devpost). The submission closes on 2027-01-11 at 8:00 am PT, which is 5:00 pm in Spain. The entry must conform to the open agentic web specification in `cognizant-ai-labs/agentic-web`, and the project must be open source.

The second goal is business: the "we do it for you" contact brings consulting leads to Juan.

The full set of decisions, hackathon facts, competitor notes and open questions is in the [design brief](research/2026-11-14-retrofit-brief.md). Read it completely before planning.

## What exists and what does not

This repository holds the workspace setup only: shared instructions, native RPI skills, the license, this briefing and the design brief. There is no application code, no stack decision, no test suite, no deployment target and no domain configuration.

- Repository: https://github.com/juan294/retrofit
- Local workspace: `/Users/juan/code/retrofit`
- Integration branch: `develop`. Production branch: `main`.
- License: Apache-2.0, the same license as the specification repository. The organizers have not stated which license they expect.

## Constraints that the plan must keep

- Conformance comes first. Stage 1 of judging is pass or fail on the specification.
- A visitor's LLM key stays in the browser and never reaches Retrofit servers.
- Retrofit reads third-party public sites. It must follow robots rules, cache results and limit requests per site.
- A preview for a site that the visitor does not own is private and labelled unofficial. Official publishing needs an ownership claim.
- Judges must have free access without restriction until 2027-01-18. Payment starts after that date.
- The video must not show third-party trademarks.
- The product is published at a `thecreativetoken.com` subdomain (expected `retrofit.thecreativetoken.com`), so the name needs no domain of its own. No trademark search was done.

## Workspace conventions

Use native RPI skills: `/rpi-plan` in Claude or `$rpi-plan` in Codex, then the other `rpi-*` skills as the phase requires. Shared instructions live in `AGENTS.md`; `CLAUDE.md` imports them. The skills and their ownership baselines were installed through the cc-rpi lifecycle engine. Summon uses the `opus-codex` layout.

Archy tracks this project in its local fleet. That tracking does not authorize hosted graph export, deployment or changes to Sutura-owned CI routing. Query Graphify through this repository's own `graphify-out` link after indexing. If the graph is absent or stale, read the source and report it.

## Next session

Start with `/rpi-brainstorm` or `/rpi-plan` here. Read this briefing, `AGENTS.md`, the [design brief](research/2026-11-14-retrofit-brief.md) and the [setup handoff](setup-handoff.md). Read the specification in `cognizant-ai-labs/agentic-web` end to end before choosing a stack, because the earlier session read only parts of it. The first build step is the path from URL to live preview. Stop after the reviewed plan. This setup does not authorize implementation, deployment, domain changes or publication.
