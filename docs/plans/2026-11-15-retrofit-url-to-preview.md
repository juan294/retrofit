# Plan: Retrofit, from URL to live preview

> Created 2026-11-15. Status: **proposed, reviewed once, awaiting owner acceptance**. This plan does not authorize implementation, deployment, provider accounts, DNS changes or any push.

## Objective

Build the first working path of Retrofit: a visitor pastes a public URL, Retrofit reads the site safely, scores how ready it is for agents, builds a working agent grounded in that site and runs it in the visitor's browser as a private, unofficial preview. Retrofit itself publishes a conforming agent network with a default router, a grounded site action and an interface.

At the end of Phase 6, Retrofit is live at `https://retrofit.thecreativetoken.com` with free inference. The organizers' partner check passes in production. Every spec §6 interoperability check is demonstrated on the release candidate, with a second loopback origin standing in for the peer. The production two-origin demonstration on a `demo-*` host belongs to the second plan, so the release profile item `open-agentic-web-spec-conformance-evidence` stays partly open until then (see Phase 6).

The plan file and phase files are the contract. Each phase stops at its acceptance gate.

## Inputs and baseline

- Repository `juan294/retrofit`, branch `develop`, base commit `44c5325` (local, one commit ahead of `origin/develop` at `c5dac9b`). Working tree clean when the plan was written.
- Accepted design: [design brief](../research/2026-11-14-retrofit-brief.md), [briefing](../briefing.md), [open source and key panel decisions](../decisions/2026-11-15-open-source-and-key-panel-style.md).
- Controlling rules read in full: `AGENTS.md`, `.rpi/rules/webmcp.md`, `.rpi/rules/testing.md`, `.rpi/rules/deployment-safety.md`, `.rpi/rules/resource-lifecycle.md`, `.rpi/rules/supabase.md`, `docs/development/resource-lifecycle.md`, `docs/release/release-playbook.md`, `.rpi/policy.json`, `.rpi/release-profile.json`.
- No project overlay exists (`.rpi/project/rpi-plan.md` is absent). No declared override is applied.

### Specification read

`cognizant-ai-labs/agentic-web` at commit `63a956cf4653f610b1c238c70946f4d7647d17a8` (2026-11-13), "MVP Profile 0.2, 6 November 2026".

- Read in full by the planner: `docs/worldwide_agentic_web_mvp_spec.md`, `README.md`, `docs/quickstart.md`, `docs/agentic_websites.md`, `docs/providers/providers.md`, `docs/providers/otari.md`, `skills/agentify-website/references/live_url_mode.md`. Read in part: `runtime/index.js:1-98`, `runtime/llm.js:60-125`, `runtime/engine.js:50-104`, `:158-175`, `:222-230`, `runtime/remote.js:1-14`, `runtime/byok.js:1-20`, `runtime/ui.js:31-75`, `scripts/check_partner.mjs:13-17`, `scripts/build_network.mjs:128-135`, `:1030-1043`.
- Read by a delegated read-only agent: `skills/agentify-website/SKILL.md`, all `references/*.md`, `scripts/build_network.mjs`, `scripts/check_partner.mjs`, `scripts/serve_site.mjs`, the templates, the runtime modules in part, `tests/linking/README.md` and the test suites in outline. Not read: the example site scripts, the bodies of `tests/linking/*.mjs`, the Chrome harness.
- Normative data model: Neuro SAN `docs/agent_hocon_reference.md` at `cognizant-ai-lab/neuro-san` commit `71b9f419298c6986e42e88a6b4d42bfa60bfb3bc`. Only its section outline was read. Retrofit emits a small fixed subset (`llm_config.model_name`, `max_steps`, `max_execution_seconds`, `metadata.description`, `metadata.sample_queries`, `tools[].name`, `function.description`, `function.parameters`, `instructions`, `tools`). The emitted networks declare no `sly_data` and no `allow` rules, so private context is denied by default (spec §2.1). Phase 4 entry reads the reference sections for those fields.

Re-read the repository at Phase 4 entry and Phase 6 entry. If the commit changed, record the new commit and diff `docs/worldwide_agentic_web_mvp_spec.md` and `skills/agentify-website/runtime/` before relying on this plan.

## Facts that shape the design

VERIFIED from the files named.

1. A conforming site publishes `agent-manifest.json` (networks with `name`, `front_man`, `hocon`; router metadata; peer policy) and a resolved network definition as JSON, with CORS for cross-origin callers (spec §3.3). Co-bundled same-origin artifacts need no CORS (spec §3.4).
2. The interoperability checks (spec §6) include a two-agent network on an ordinary HTTPS host, a run with the site's published default router, a grounded capability through MCP or a local site action, peer loading from a second origin after approval, key isolation from peers, private-context filtering, and visible errors for an invalid network, a cycle, an over-budget request and a denied origin.
3. The organizers' runtime (`skills/agentify-website/runtime/`) is Apache-2.0 (`runtime/LICENSE.txt`), plain ES modules, no build step. `boot(selector, {originUrl, byokKey, router, model, sandboxWorkerUrl})` accepts key, router and model from the host page (`runtime/index.js:46-54`).
4. The runtime refuses a real model call without a key that is not `"demo"` (`runtime/llm.js:69-71`). The engine fixes the key when it constructs the model client (`runtime/engine.js:101`, `:227`), so a key cannot change without a reboot.
5. With a real key and no router override, the runtime switches to the manifest's `byok_router` (`runtime/engine.js:54-66`). With an override, it uses the override.
6. `originUrl` must be absolute: the engine calls `new URL(base)` on it (`runtime/engine.js:172`, `runtime/remote.js:6-12`).
7. On loopback hosts only, the runtime mirrors BYOK profiles to a cookie (`runtime/byok.js:3-6`). It stores profiles in `localStorage` key `nsweb-byok-profiles-v1` and tab setup in `sessionStorage` items `nsweb-byok-*` (`runtime/byok.js:11-17`).
8. Action modules load only from their own origin (`runtime/action-transport.js:12-14`). A preview of a site that Retrofit does not control is a companion assistant: it answers from a content snapshot through `search_site_content` and `get_site_records` and links to the real page (`references/live_url_mode.md:15-21`). This answers the brief's open question about cart and booking functions: Retrofit cannot act on them until the owner installs the bundle (second plan).
9. `scripts/build_network.mjs` uses only Node built-ins, makes no LLM or network call, needs Node 22 or newer, writes the network JSON, discovery and bridge files next to the manifest, and in `--check` mode fails when an expected output file is missing (`build_network.mjs:128-135`, `:1030-1043`; agent report `:731-748`). `scripts/check_partner.mjs` imports `../runtime/*` (`check_partner.mjs:13-17`) and checks a published site over HTTP as a browser would. These scripts are the conformance oracles. The README's validation script is still marked TODO (`README.md`, "Testing").
10. The organizers' published agent at `worldwideagenticweb.org` sends no `Access-Control-Allow-Origin` header (checked 2026-11-15 with `curl -H 'Origin: https://retrofit.thecreativetoken.com'`; both files HTTP 200 without the header). It cannot be the peer in a linking demo.
11. DNS for `thecreativetoken.com` is in Route 53 hosted zone `Z05609513HH99AFEUOPD3`, reachable with the `aws` CLI. The Vercel team `thecreativetoken` exists and `vercel` is logged in as `juan294`.
12. `git.deploymentEnabled: false` turns off Git deployments for all branches; an object maps branches, and unspecified branches default to `true` (Vercel docs, "Git configuration"). The fleet pattern in `/Users/juan/code/clarity/vercel.json` disables `develop` and `sutura/*` and adds `"ignoreCommand": "test \"$VERCEL_ENV\" != \"production\""`.
13. Local ports 3001 to 3008 are assigned in `/Users/juan/code/archy/docs/local-development-ports.md`. Local Supabase API ports used by the fleet: 54321, 54331, 54421, 54521, 54621, 55321, 56321, 56621.

## Owner decisions (2026-11-15)

Phase 1 writes them to `docs/decisions/2026-11-15-stack-and-hosting.md`.

| Decision | Choice |
| --- | --- |
| Stack | Next.js 16 (App Router) on Vercel, pnpm, Node 24, TypeScript 6, ESLint 9, Vitest 4, Playwright, Tailwind 4. Same tooling as Portfolio, Coach and Clarity. |
| Free inference | Hosted Otari (`https://api.otari.ai/api/v1`) with the hackathon credits, model `alibaba/qwen3.8-flash`, behind a Retrofit endpoint with caps. |
| Production storage | Supabase Postgres for the fetch cache, rate-limit counters and analysis records (later accounts and claims). Tests and local development use an in-memory store with the same contract. |
| Second origins | `demo-*.thecreativetoken.com`, each a separate Route 53 record. Used by the second plan. |
| Key panel style | New neutral style. |
| Open source | Whole project, server code included, Apache-2.0. Repository public since 2026-11-15. |

## Planner decisions (from evidence; the owner can change any of them at acceptance)

- **Deterministic network generation.** A template turns the snapshot into a two-agent companion network. No LLM builds it. Fact 9 gives an exact oracle, and generation costs nothing.
- **Vendor the runtime unchanged** at the recorded commit, with a checksum manifest. No fork, no patches.
- **Free path authentication.** The runtime always sends a fixed placeholder key `retrofit-free` with an explicit router override to `<origin>/api/inference/v1`. The real credential is an HttpOnly, `SameSite=Strict` session cookie that the page renews without rebooting the runtime (facts 4 and 5). The manifests publish `<origin>/api/inference/v1` as `llm_router.base_url` and hosted Otari as `byok_router`, so a visitor's real key used without an override goes to Otari, never to Retrofit.
- **Judge pool.** A separate daily quota for judges, unlocked by a code that the owner puts in the Devpost submission text. The public free pool stays open to everyone; the code only adds capacity, so it is not a payment or access restriction.
- **Single origin, no third-party scripts.** The brief says to host the panel and runtime on a separate subdomain with no third-party scripts (brief, "Key entry panel"). This plan keeps the app, the previews and the runtime on `retrofit.thecreativetoken.com`, because the runtime loads action modules only from the preview's own origin (fact 8). It meets the intent with a strict nonce CSP that permits no third-party script origin, tested in Phase 1. This is a recorded deviation from the brief.
- **CD.** The first production deploy is `vercel deploy --prod` from the verified merge commit, before Git is connected. After that, Vercel Git integration deploys only `main`, with `develop` and `sutura/*` disabled and the fleet `ignoreCommand` as a second guard (fact 12). Each merge to `main` is a production deploy and needs the owner's authorization.
- **CI.** The local gate is the source of truth. Phase 1 writes the proposed GitHub Actions workflow as a handoff for Sutura; this plan does not add `.github/`.
- **Ports.** Dev 3009, Playwright server 3010, second loopback test origin 3011. Local Supabase: reusable dev stack 54720 to 54729, disposable gate stack 54730 to 54739.
- **Supabase region** `us-east-1`, next to Vercel's default function region (INFERRED `iad1`; confirmed in Phase 6 before the project is created). Expired rows are removed on read and by a daily Vercel Cron job.

## Architecture

```
visitor browser                                   retrofit.thecreativetoken.com (Vercel, Node runtime)
-----------------------------------------         -------------------------------------------------------
/ landing: URL form + Retrofit's own agent  ----> POST /api/analyze  -> analysis record + snapshot (Store, 7 days)
/r/<id>: progress, score, preview         <----  GET  /api/analyze/<id>   (poll)
  preview: vendored runtime boot() with            waitUntil: guarded crawl -> snapshot -> score -> generate
  originUrl <origin>/p/<id> (private,     ---->  GET /p/<id>/agent-manifest.json, <net>.network.json,
  noindex, same origin)                               site-content.json, content-actions.js, bridge/
  key panel: BYOK -> provider router
     (direct; key never sent to Retrofit)
  free path: key "retrofit-free" + router  ---->  /api/inference/v1: session cookie, same-origin check,
     override <origin>/api/inference/v1             caps -> Otari with the server key
Retrofit's own agent: /agent-manifest.json,       GET /api/score?url=  (site action score_site, agents)
  /retrofit_guide.network.json (CORS *)
                                                  Store: memory (tests, local) | Supabase (production)
third-party site  <------------------------------ guarded fetch: SSRF guard, robots per host, pacing, limits
```

Fetched content is untrusted data. It reaches the model only as tool results, never inside agent instructions. Instructions contain only fixed text, the validated host name and the snapshot date.

## Phases

| Phase | File | Outcome | Estimate (INFERRED) |
| --- | --- | --- | --- |
| 1 | [phase-1.md](2026-11-15-retrofit-url-to-preview-phases/phase-1.md) | Scaffold, configuration, CSP, vendored runtime, full local gate, decision record, CI handoff | 1 to 2 days |
| 2 | [phase-2.md](2026-11-15-retrofit-url-to-preview-phases/phase-2.md) | Safe fetch service and site snapshot | 2 to 3 days |
| 3 | [phase-3.md](2026-11-15-retrofit-url-to-preview-phases/phase-3.md) | Score tool contract, deterministic score, analysis flow, pages | 2 to 3 days |
| 4 | [phase-4.md](2026-11-15-retrofit-url-to-preview-phases/phase-4.md) | Generator, live preview, key panel, Retrofit's own agent, local §6 checks | 5 to 6 days |
| 5 | [phase-5.md](2026-11-15-retrofit-url-to-preview-phases/phase-5.md) | Free inference through Otari with caps and the judge pool | 2 days |
| 6 | [phase-6.md](2026-11-15-retrofit-url-to-preview-phases/phase-6.md) | Supabase store, evidence analyzer, Vercel hosting, DNS, first production release | 3 days plus authorization time |

The estimates total about 15 to 19 working days. That leaves about 3 to 4 weeks before the 2027-01-11 deadline for the second plan. Phases run in order, and each needs owner acceptance before the next starts unless the owner authorizes continuation.

### Second plan (out of scope here)

The plan step and file bundle; the ownership claim by meta tag or DNS record; `demo-*` merchant sites where the installed bundle acts on a cart or booking with confirmation (the runtime runs `write` actions without review, `SKILL.md:203-205`, which must be handled first); the production two-origin linking demonstration; the "we do it for you" contact; an MCP endpoint and WebMCP tools for the score; the "notify me" pricing page; the "built-in AI, no key" option (Chrome Prompt API tool calling is unconfirmed); the video, screenshots and Devpost form.

## Oracles

- **Runtime validation:** vendored `validateNetwork` (`public/runtime/kernel.js`) accepts every generated network and rejects the invalid fixtures.
- **Organizers' build:** `node tools/agentic-web/scripts/build_network.mjs <dir>/<net>.hocon --manifest <dir>/agent-manifest.json --runtime tools/agentic-web/runtime` exits 0 for Retrofit's own network and for each generated fixture network, and non-zero for the invalid fixture. `--check` exits 0 for the committed Retrofit network files.
- **Organizers' partner check:** `node tools/agentic-web/scripts/check_partner.mjs <url>/retrofit_guide` exits 0 against `next start` (Phase 4) and against production (Phase 6).
- **Spec §6 harness:** the Playwright specs in Phase 4, modeled on the organizers' linking cases L1 to L10 and C1 to C8 (`tests/linking/README.md:38-98`).
- **Golden scores:** `tests/fixtures/expected-scores.json`.
- **Address table:** `tests/fixtures/address-cases.json`.
- **Evidence analyzer:** `tools/release/analyze-evidence.mjs` with its rejection fixtures (Phase 6).
- **Contract probe:** one recorded streamed tool-call exchange with real Otari (Phase 5).

## Stuck states and recovery

| State | Who sees it and what they see | How it ends | Test |
| --- | --- | --- | --- |
| Analysis stays in `crawling` because the function stopped | Visitor on `/r/<id>`: "This analysis took too long. Try again." with Retry | A read marks the record failed when `updatedAt` is older than 90 s; the host lock (60 s) has expired by then, so Retry starts a new crawl | `tests/analysis/stale.test.ts` (Phase 3) |
| robots.txt disallows Retrofit on a host | Visitor: "This site asks automated tools not to read it. Retrofit stopped and read nothing else." | Visitor tries another URL; the owner can allow `RetrofitBot` | `tests/fetch/robots.test.ts`, `e2e/analyze-blocked.spec.ts` |
| robots.txt returns 5xx or times out | Visitor: "Retrofit could not read this site's robots rules, so it stopped. Try again after HH:MM." | Result cached 1 h, then a new try is allowed | `tests/fetch/robots.test.ts` |
| Per-client analysis limit reached (20 per hour) | Visitor: "You reached the limit of 20 analyses per hour. Try again at HH:MM." | Window expires | `tests/fetch/limits.test.ts`, `tests/api/analyze.test.ts` |
| Address is not a public website | Visitor: "This address is not a public website." | Visitor enters another URL | `tests/fetch/guard.test.ts` |
| Generated network fails validation | Visitor sees the score and "Retrofit could not build a working agent for this site." No preview | Generator fix; the reason is kept in the record | `tests/generate/validate.test.ts` |
| Preview expired (record older than 7 days) | Visitor on `/p/<id>` or `/r/<id>`: "This preview expired on <date>. Analyze the site again." with a button | Visitor starts a new analysis | `tests/analysis/expiry.test.ts` |
| Key test fails (401, CORS, model not listed) | Key panel: a provider-specific message, for example "Anthropic refused a browser call for this organization. Use OpenRouter for Claude models." | Visitor fixes the key or uses Advanced settings | `tests/keys/test-key.test.ts`, `e2e/key-panel.spec.ts` |
| `score_site` called while the score is still running | Agent receives "The score is still running. Call score_site again in 20 seconds with the same URL." | Agent calls again | `tests/agent/score-action.test.ts` |
| Free cap reached (session, client or public daily pool) | Chat and banner: "Retrofit's free AI is used up for <reason>. Paste your own key in AI settings to continue." | Visitor adds a key, or the window resets; judges use the judge pool | `tests/inference/quota.test.ts`, `e2e/free-path.spec.ts` |
| Session cookie expired | The page renews the session every 30 min and when the tab becomes visible; the next call uses the new cookie. If a call still fails: "Your free session expired. Reload the page." | Automatic renewal, or reload | `tests/inference/token.test.ts`, `e2e/free-path.spec.ts` |
| Otari error or timeout | Chat: "The free AI provider did not answer. Try again, or use your own key." | Visitor retries; the proxy never retries | `tests/inference/proxy.test.ts` |
| Store unavailable in production | Visitor: "Retrofit is having trouble. Try again in a few minutes." `/api/health` returns `degraded` | Supabase recovers; no fallback to memory in production | `tests/store/supabase-failure.test.ts` (Phase 6) |
| Gate Supabase stack held by another gate run | Developer: "Another gate run owns the test database (pid N, started HH:MM)." | That run finishes and releases the lock; a lock whose pid is dead is reported, not removed | `tests/tools/gate-db-lock.test.ts` (Phase 6) |
| Vendored runtime changed or damaged | Developer: `pnpm vendor:verify` names each changed, missing or extra file | Re-run `pnpm vendor:sync` from the recorded commit | `tests/vendor/verify.test.ts` |

## Consumer sweep

No application code exists, so no existing caller can break. This plan defines four shared formats. Before each phase is accepted, run `rg -n "Snapshot|AnalysisRecord|Store|SessionClaims" src tests e2e tools` and confirm that the list is complete.

| Format | Producers | Consumers |
| --- | --- | --- |
| `Snapshot` (superset of `site-content.json`) | `src/lib/fetch/crawl.ts`, `src/lib/fetch/extract.ts` (Phase 2) | `src/lib/score/*` (Phase 3), `src/lib/analysis/run.ts` (stores it with the record, Phase 3), `src/lib/generate/*` and `src/app/p/[id]/[...file]/route.ts` (Phase 4), vendored `public/preview-assets/content-actions.js` (expects `pages` and `records`), `tests/fixtures/snapshots/` |
| `AnalysisRecord` | `src/lib/analysis/run.ts` (Phase 3, extended in Phase 4) | `src/app/api/analyze/*`, `src/app/api/score/route.ts`, `src/app/r/[id]/page.tsx` (Phase 3), `src/app/p/[id]/[...file]/route.ts` (Phase 4), `e2e/` helpers |
| `Store` contract | `src/lib/store/memory.ts` (Phase 2), `src/lib/store/supabase.ts` (Phase 6) | `src/lib/fetch/limits.ts`, `src/lib/fetch/cache.ts` (Phase 2), `src/lib/analysis/*` (Phase 3), `src/lib/inference/quota.ts` (Phase 5), `src/app/api/health/route.ts`, `src/app/api/cron/cleanup/route.ts` (Phase 6), `tests/store/contract.ts` |
| `SessionClaims` | `src/lib/inference/token.ts`, `src/app/api/session/route.ts` (Phase 5) | `src/app/api/inference/v1/*` routes, `src/lib/inference/quota.ts` (Phase 5) |

## Risks

- **Specification churn.** Mitigation: pinned commit, checksum manifest, re-read at Phase 4 and Phase 6 entry.
- **Vendored runtime churn.** The runtime may move to a new TypeScript runtime (`runtime/README.md:58-64`). Mitigation: no patches; only `src/components/preview/Preview.tsx` calls its API.
- **Free-inference cost.** The Otari credit balance is unknown. Caps are configuration; the owner sets them after checking the balance.
- **Abuse of the public free pool.** Cross-origin calls are refused, but a determined visitor can still spend the public daily pool. The judge pool keeps judges unaffected.
- **Next.js CSP details.** INFERRED: Next.js 16 uses `src/proxy.ts` for the request hook, and `'strict-dynamic'` allows the runtime's `import()` calls. Phase 1 and the Phase 4 browser tests confirm both against the installed version.
- **Serverless time limits.** Page budget 12, per-request timeout 8 s, crawl budget 45 s, `maxDuration` 60 s, stale detection at 90 s.
- **Single origin.** A script injection anywhere on the origin could read a visitor's key, which the spec also states for BYOK (spec §4, "Threat boundary"). Mitigation: no third-party scripts, nonce CSP, no `dangerouslySetInnerHTML` with fetched content (lint rule).

## Review record

An independent read-only review of this plan was run on 2026-11-15 against the spec clone, the brief, `AGENTS.md`, the rules and the playbook. Findings and dispositions (all resolved in this revision):

| ID | Sev | Finding | Disposition |
| --- | --- | --- | --- |
| R1 | S1 | `check_partner.mjs` imports `../runtime/*`; the vendor layout broke it | Phase 1 also vendors `runtime/` to `tools/agentic-web/runtime` |
| R2 | S1 | `build_network --check` fails on missing outputs; the default runtime path was wrong | Oracle runs without `--check` into a temp directory with `--runtime` |
| R3 | S2 | Build writes outputs next to the manifest | Retrofit's manifest lives at `public/agent-manifest.json` |
| R4 | S1 | Conformance claim did not cover spec §6 | Phase 4 adds the §6 harness on a second loopback origin; objective and Phase 6 state what stays open |
| R5 | S1 | Evidence analyzer and safety evidence missing before release | Phase 6 builds and tests the analyzer; safety specs are named required evidence |
| R6 | S1 | Loopback override tied to `NODE_ENV`, which `next start` sets to production | Override refused only on Vercel (`VERCEL` or `VERCEL_ENV` set); test added |
| R7 | S2 | Relative `originUrl` breaks boot | Absolute `${location.origin}/p/<id>` |
| R8 | S2 | Token renewal ineffective because the key is fixed at compile | HttpOnly session cookie with a fixed placeholder key |
| R9 | S2 | Manifests had no default router values | `base_url` is Retrofit's endpoint, `byok_router` is Otari; boot test without the runtime's own profile |
| R10 | S2 | Runtime's own storage and loopback cookie not cleared | Runtime settings slot hidden; Forget clears `nsweb-byok-*` and the cookie; test |
| R11 | S2 | Nonce CSP blocks the static bridge | Bridge paths get `script-src 'self'`; cross-origin iframe test |
| R12 | S2 | Page title entered instructions | Instructions use only the validated host and date; hostile-title fixture |
| R13 | S2 | robots not checked on redirect hosts and probes | robots evaluated for every host contacted; apex-to-www test |
| R14 | S2 | Limit, window and lock values undefined | Values set in Phase 1 config; lock 60 s below stale 90 s; Retry test |
| R15 | S2 | Snapshot TTL shorter than preview life | Snapshot stored with the record for 7 days; expiry state and test |
| R16 | S2 | Free path open to cross-origin use; judges could be blocked | Same-origin checks with tests; judge pool |
| R17 | S2 | Supabase gate reset contradicted the reusable class | Separate disposable gate stack with recorded ownership and teardown |
| R18 | S2 | `rpi-tool-design` skipped; 202 not mapped | Run at Phase 3 entry; 202 mapped to recovery text with a test |
| R19 | S2 | No proof of which origins a preview contacts | Origin-recording e2e spec |
| R20 | S3 | Single origin deviates from the brief | Recorded as a planner decision with its reason and risk |
| R21 | S3 | Provider prefixes wrong | Provider table taken from `runtime/ui.js:31-75`, plus OpenRouter |
| R22 | S3 | Region, cleanup, `SESSION_SECRET`, private-context rules open | Decided above and in Phases 1, 4 and 6 |
| R23 | S3 | Branch default and Git-link first deploy ambiguous | `sutura/*` disabled; first deploy by CLI before Git is connected |
| R24 | S3 | Key-leak test headers only; SSRF ranges incomplete; Archy edit unspecified | Tests cover URLs, headers, bodies and cookies; 6to4, Teredo and `64:ff9b:1::/48` added; Archy edit on a local branch after a clean-tree check |

## Handoff

- **Objective and scope:** this plan, Phases 1 to 6. Approved scope so far: planning only. No implementation, push, deployment, provider account, credential or DNS action is authorized.
- **State at writing:** branch `develop` at `44c5325`, `origin/develop` at `c5dac9b`, worktree `/Users/juan/code/retrofit`. Spec commit `63a956c`. Neuro SAN reference commit `71b9f41`.
- **Evidence limits:** listed under "Specification read". Next.js 16 behavior and the HOCON reference bodies were not checked.
- **Decisions:** owner decisions and planner decisions above. The planner decisions on the judge pool and the single origin change what the brief says and need the owner's acceptance with the plan.
- **Review:** R1 to R24 above, all resolved in this revision. No second review was run on the revision.
- **Overlay:** none present; no override applied.
- **Next step:** owner review. On acceptance, start Phase 1 in a worktree with `/rpi-implement`, using the phase file as the contract.
