# Plan: Retrofit, from URL to live preview

> Created 2026-11-15. Revision 5, after four independent assessments. Status: **proposed, awaiting owner acceptance**. This plan does not authorize implementation, deployment, provider accounts, credentials, DNS changes or any push.

## Objective

Build the first working path of Retrofit: a visitor pastes a public URL, Retrofit reads the site safely, scores how ready it is for agents, builds a working agent grounded in that site and runs it in the visitor's browser as a private, unofficial preview. Retrofit itself publishes a conforming agent network with a default router, a grounded site action, an interface, and a consented link to a second production origin.

At the end of Phase 7, Retrofit is live at `https://retrofit.thecreativetoken.com` with free inference and a reserved judge capacity. Every spec §6 interoperability check is demonstrated in production, with the synthetic peer `https://demo-harbor.thecreativetoken.com`. A one-day spike (Phase 5) has reduced the main risk of the second plan.

The plan file and phase files are the contract. Each phase stops at its acceptance gate.

## Inputs and baseline

- Repository `juan294/retrofit`, branch `develop`, base commit `4161197` (plan revision 1). `origin/develop` at `44c5325`.
- Accepted design: [design brief](../research/2026-11-14-retrofit-brief.md), [briefing](../briefing.md), [open source and key panel decisions](../decisions/2026-11-15-open-source-and-key-panel-style.md).
- Assessments of this plan: the in-session review (R1 to R24, below), the [second assessment](../research/2026-11-15-url-to-preview-plan-second-assessment.md) (R25 to R40) the [revision 3 assessment](../research/2026-11-15-url-to-preview-revision-3-assessment.md) (R29, R30 and R39 follow-ups, R41 to R43, four harness items) and the [revision 4 assessment](../research/2026-11-15-url-to-preview-revision-4-assessment.md) (R44, R39 and R30 follow-ups, two adapter details).
- Controlling rules read in full: `AGENTS.md`, `.rpi/rules/webmcp.md`, `.rpi/rules/testing.md`, `.rpi/rules/deployment-safety.md`, `.rpi/rules/resource-lifecycle.md`, `.rpi/rules/supabase.md`, `docs/development/resource-lifecycle.md`, `docs/release/release-playbook.md`, `.rpi/policy.json`, `.rpi/release-profile.json`. Verifier source read in part: `.rpi/scripts/rpi-verify.py:163-210`.
- No project overlay exists (`.rpi/project/rpi-plan.md` is absent). No declared override is applied.

### Specification read

`cognizant-ai-labs/agentic-web` at commit `63a956cf4653f610b1c238c70946f4d7647d17a8` (2026-11-13), "MVP Profile 0.2, 6 November 2026".

- Read in full by the planner: `docs/worldwide_agentic_web_mvp_spec.md`, `README.md`, `docs/quickstart.md`, `docs/agentic_websites.md`, `docs/providers/providers.md`, `docs/providers/otari.md`, `skills/agentify-website/references/live_url_mode.md`. Read in part: `runtime/index.js:1-98`, `runtime/llm.js:60-125`, `runtime/engine.js:50-104`, `:158-175`, `:222-230`, `runtime/remote.js:1-17`, `runtime/byok.js:1-20`, `runtime/ui.js:31-75`, `:274-283`, `:390-416`, `scripts/check_partner.mjs:13-17`, `scripts/build_network.mjs:128-135`, `:1030-1043`.
- Read by delegated read-only agents: `skills/agentify-website/SKILL.md`, all `references/*.md`, `scripts/*.mjs`, the templates, the runtime modules in part, `tests/linking/README.md`, the test suites in outline. Not read: the example site scripts, the bodies of `tests/linking/*.mjs`, the Chrome harness.
- Normative data model: Neuro SAN `docs/agent_hocon_reference.md` at `cognizant-ai-lab/neuro-san` commit `71b9f419298c6986e42e88a6b4d42bfa60bfb3bc`, outline only. Retrofit emits a small fixed subset (`llm_config.model_name`, `max_steps`, `max_execution_seconds`, `metadata.description`, `metadata.sample_queries`, `tools[].name`, `function.description`, `function.parameters`, `instructions`, `tools`). The emitted networks declare no `sly_data` and no `allow` rules, so private context is denied by default (spec §2.1). Phase 4 entry reads the reference sections for those fields.

Re-read the specification repository at Phase 4, Phase 5 and Phase 7 entry. If the commit changed, record the new commit and diff `docs/worldwide_agentic_web_mvp_spec.md` and `skills/agentify-website/runtime/` before relying on this plan.

## Facts that shape the design

VERIFIED from the files named.

1. A conforming site publishes `agent-manifest.json` and a resolved network definition as JSON, with CORS for cross-origin callers (spec §3.3). Same-origin artifacts need no CORS (spec §3.4).
2. The spec §6 checks: a two-agent network on an ordinary HTTPS host; a run with the site's published default router; a grounded capability through MCP or a local site action; peer loading from a second origin after approval; key isolation from peers; private-context filtering; visible errors for an invalid network, a cycle, an over-budget request and a denied origin.
3. The runtime is Apache-2.0, plain ES modules, no build step. `boot(selector, {originUrl, byokKey, router, model, sandboxWorkerUrl})` accepts key, router and model from the host page (`runtime/index.js:46-54`).
4. The runtime refuses a real model call without a key that is not `"demo"` (`runtime/llm.js:69-71`) and fixes the key when it builds the model client (`runtime/engine.js:101`, `:227`).
5. With a real key and no router override, the runtime switches to the manifest's `byok_router` (`runtime/engine.js:54-66`). With an override, it uses the override.
6. `originUrl` must be absolute (`runtime/engine.js:172`, `runtime/remote.js:6-12`).
7. On loopback hosts only, the runtime mirrors BYOK profiles to a cookie (`runtime/byok.js:3-6`); it stores profiles in `localStorage` `nsweb-byok-profiles-v1` and tab setup in `sessionStorage` `nsweb-byok-*` (`runtime/byok.js:11-17`).
8. Action modules load only from the runtime's own origin (`runtime/action-transport.js:12-14`), so a preview of a site Retrofit does not control is a companion assistant that answers from a snapshot (`references/live_url_mode.md:15-21`). Acting on that site needs the owner's installed bundle (second plan).
9. The runtime UI appends a `<style>` element without a nonce (`runtime/ui.js:278-281`) and renders markup with inline `style="..."` attributes through `innerHTML` (6 occurrences in `runtime/ui.js`; `:390-416`). No nonce or hash can permit style attributes, so a CSP that runs the unchanged runtime needs `style-src 'self' 'unsafe-inline'`.
10. The runtime fetches peer manifests and networks with plain `fetch(url)` (`runtime/remote.js:9`, `:16`), which follows redirects. The spec requires a redirect to another origin to be treated as a new destination (spec §5, "Explicit destinations").
11. `build_network.mjs` uses only Node built-ins, writes outputs next to the manifest and fails `--check` on missing outputs (`build_network.mjs:128-135`, `:1030-1043`). `check_partner.mjs` imports `../runtime/*` (`check_partner.mjs:13-17`). These are the conformance oracles. The README's validation script is still TODO.
12. `rpi-verify.py` runs each check with `subprocess.run(argv, cwd=root)` and passes no attempt identity to it (`rpi-verify.py:191`); it records its own attempt id and tree identity in `.rpi/local/verification.json`.
13. The organizers' published agent at `worldwideagenticweb.org` sends no CORS header (checked 2026-11-15), so it cannot be a linking peer.
14. DNS for `thecreativetoken.com` is in Route 53 zone `Z05609513HH99AFEUOPD3`, reachable with the `aws` CLI. The Vercel team `thecreativetoken` exists.
15. `git.deploymentEnabled` maps branches to booleans, and unspecified branches default to `true` (Vercel docs). The fleet pattern (`clarity/vercel.json`) disables `develop` and `sutura/*` and adds `"ignoreCommand": "test \"$VERCEL_ENV\" != \"production\""`.
16. Ports 3001 to 3008 are assigned in Archy's port list. Fleet local Supabase API ports: 54321, 54331, 54421, 54521, 54621, 55321, 56321, 56621.
17. The runtime keeps peer consent per host: `engine.requestConsent(info)` returns `"allow"` or a decline for `info.peerOrigin`, which is `URL.host` (host and port, no scheme) (`runtime/runner.js:33-34`, `:428`), and the runner calls it through the engine instance (`runtime/engine.js:109-139`, `:365`). The runtime's router probe requests `<router origin>/agent-manifest.json` (`runtime/engine.js:41-44`). After approval, the runtime resolves the peer manifest's `hocon` value, which may be an absolute URL on any origin, and fetches it (`runtime/engine.js:193-195`).
18. The runtime's stream reader skips JSON without `choices`, skips non-`data:` lines, and returns the accumulated content when the stream ends normally (`runtime/llm.js:174-178`, `:209`, `:223`). It throws only on a non-OK HTTP status (`runtime/llm.js:128-131`) or a transport error.
19. Tool results go back to the model as `{role: "tool", tool_call_id, name, content}` (`runtime/runner.js:585`), and the messages are sent unchanged (`runtime/llm.js:85-92`).
20. The runtime prevents composition cycles before they run: when it builds a tool table, it removes a remote reference already visited in this request and records a `composition_skip` trace event with reason `already visited in this request` (`runtime/runner.js:168-174`). It does not throw a cycle error on this path.

## Owner decisions (2026-11-15)

Phase 1 writes them to `docs/decisions/2026-11-15-stack-and-hosting.md`.

| Decision | Choice |
| --- | --- |
| Stack | Next.js 16 (App Router) on Vercel, pnpm, Node 24, TypeScript 6, ESLint 9, Vitest 4, Playwright, Tailwind 4. |
| Free inference | Hosted Otari with the hackathon credits, model `alibaba/qwen3.8-flash`, behind a Retrofit endpoint with spend caps. |
| Production storage | Supabase Postgres; in-memory store with the same contract for tests and local development. |
| Second origins | `demo-*.thecreativetoken.com`. This plan publishes `demo-harbor.thecreativetoken.com`. |
| Key panel style | New neutral style. |
| Open source | Whole project, Apache-2.0, repository public since 2026-11-15. |
| Key origin | `retrofit.thecreativetoken.com` is the key-bearing origin and serves only first-party code. No third-party script may ever run on it; a gate test enforces this. Future pages that need third-party scripts (payment, analytics) go on another origin. |
| Judge access | A judge reserve of credits, protected by hard public spend caps through 2027-01-18; a judge code delivered in a judges-only Devpost field if the form has one, else in the public submission text; a daily credit check that alerts the owner; BYOK always available. The strength of the reserve guarantee is settled at Phase 6 acceptance (see "Spend control" below). |
| Release scope | Full spec §6 in production before the first release, with the synthetic peer `demo-harbor.thecreativetoken.com`. |
| Schedule | A one-day write-confirmation spike after Phase 4, and the second plan's critical path outlined here. |

## Planner decisions (from evidence; the owner can change any at acceptance)

- **Deterministic network generation** from the snapshot with fixed templates. No LLM builds it.
- **Vendor the runtime unchanged** at the recorded commit, with a checksum manifest. Containment lives in Retrofit's adapter (`src/components/preview/Preview.tsx`), never in vendored files.
- **CSP:** `script-src 'self' 'nonce-<n>'` without `'strict-dynamic'`, so trust does not propagate to scripts loaded by other scripts; `style-src 'self' 'unsafe-inline'` because of fact 9 (styles only; scripts stay strict); exact `connect-src` lists.
- **Destination containment (facts 10 and 17):** the adapter wraps `fetch` while a preview is mounted. It keeps policy and consent apart:
  - a peer origin is allowed only when it is in the top manifest's `allowed_peers` **and** the visitor approved it in this page session (the adapter wraps the engine instance's `requestConsent`; the approved `host:port` must match exactly one configured origin, else nothing is approved)
  - the router origin is allowed only for `POST <router>/chat/completions`, `GET <router>/models` and the runtime's own `GET <router origin>/agent-manifest.json` probe
  - a provider origin the visitor is setting up is allowed only for `GET <router>/models`, through an explicit `authorizeProvider` call from the key panel, and is revoked if validation fails or the key is forgotten
  - every cross-origin request, and every same-origin request for agent artifacts (`/p/*`, `/agent-manifest.json`, `*.network.json`, `/links.json`), uses `redirect: "error"`
  - CSP `connect-src` lists the same origins as the outer bound. The runtime's own consent card still governs each peer call.
- **Free path responses are buffered (fact 18):** the endpoint reads the whole upstream completion before it answers, then returns it as one SSE body. An upstream failure at any point becomes an HTTP 502 with recovery text, which the unchanged runtime shows as an error. The free path gives up token streaming for this.
- **Private previews:** shared crawl and score data are separate from visitor-owned analyses. A visitor cookie authorizes every result, status and preview route.
- **Free path authentication:** fixed placeholder key `retrofit-free` with an explicit router override to `<origin>/api/inference/v1`; the credential is an HttpOnly, `SameSite=Strict` cookie scoped to `/api/inference`, created and renewed at `/api/inference/session`. Manifests publish `<origin>/api/inference/v1` as `llm_router.base_url` and hosted Otari as `byok_router`, so a visitor's real key used without an override goes to Otari, never to Retrofit.
- **Spend control:** a strict request schema that accepts exactly what the vendored runtime sends (text-only content, fixed roles, bounded tools, tool results with `name`, fact 19), input and output bounds, in-flight caps, and a reservation taken before forwarding. The reservation is a conservative bound: one token per serialized request byte plus fixed framing allowances. It rests on assumptions about the provider's tokenizer, framing and billing, which Phase 6 probes test but cannot prove in general.
  - **Overrun hold:** if reported usage ever exceeds a reservation, the bound is shown false. A persistent hold closes the public pool until the owner reconciles the bound, prices, actual provider balance and outstanding reservations, and authorizes resumption with `pnpm ops:resume-free`. The hold survives UTC rollover and restarts.
  - **Judge availability** is computed from the remaining credit (ledger spend, including any overrun, plus outstanding reservations), not assumed.
  - **Guarantee level** (decided at Phase 6 acceptance): if Otari offers per-key spending limits, the public pool uses its own key capped at credit minus reserve, which gives provider-backed isolation. If not, the guarantee is qualified: the reserve is protected while the bound holds; a detected overrun stops public use; charges already made cannot be undone. The owner accepts the level before Phase 6 is accepted.
  - Reconciliation only lowers a reservation to the reported usage; it never treats spend as undone.
- **Queued crawl liveness:** queued jobs are dispatched when any worker finishes and on every analyze, status or score request; a queued job that is not started within 120 s is dropped with a truthful message.
- **Release ordering:** an authorized candidate production deployment, then production evidence bound to that deployment and commit, then analysis, then the owner's final acceptance and the tag.
- **Evidence binding (fact 12):** the gate starts with `pnpm evidence:begin` and ends with `pnpm evidence:seal`; the analyzer accepts only reports sealed in the same attempt for the same tree.
- **CD:** first production deploy with `vercel deploy --prod` from the verified merge commit before Git is connected; afterwards Git deploys only `main`, with `develop` and `sutura/*` disabled and the fleet `ignoreCommand`.
- **CI:** the local gate is the source of truth. Phase 1 hands a proposed workflow to Sutura; this plan adds no `.github/`.
- **Ports:** dev 3009, Playwright server 3010, second loopback test origin 3011, merchant spike origin 3012, third test origin 3013, performance test server 3014. Fixture host names use the reserved `.fixture.test` domain, mapped to loopback only in fixtures mode. Supabase: reusable dev stack 54720 to 54729, disposable gate stack 54730 to 54739.
- **Supabase region** next to Vercel's function region (confirmed in Phase 7 before the project is created).

## Architecture

```
visitor browser (origin retrofit.thecreativetoken.com, first-party code only)
  /                URL form, Retrofit's own agent
  /r/<id>          visitor-owned analysis: progress, score, preview         (visitor cookie required)
  preview          vendored runtime boot(), originUrl <origin>/p/<id>,
                   fetch guard: router API paths, consented allowed peers, authorized provider check, redirect "error"
  key panel        BYOK straight to the provider router (key never sent to Retrofit)
  free path        key "retrofit-free" + router <origin>/api/inference/v1, session cookie

server (Vercel, Node runtime, one deployment)
  POST /api/analyze            -> visitor analysis -> joins or starts a shared crawl job (per destination host)
  GET  /api/analyze/<id>       -> compact status (one store read)                 (visitor cookie)
  GET  /p/<id>/*               -> private preview artifacts                       (visitor cookie)
  GET  /api/score?url=         -> public score report only (agents, CORS *)
  /api/inference/session, /api/inference/v1/*  -> caps, reservations, ledger -> Otari (server key)
  crawl worker (waitUntil)     -> guarded fetch: SSRF guard, robots per host, leased pacing, limits
  Store: memory (tests) | Supabase (production)

demo-harbor.thecreativetoken.com   synthetic peer network (static, CORS *), same deployment, host-routed
```

Fetched content is untrusted data. It reaches the model only as tool results. Instructions contain only fixed text, the validated host name and the snapshot date.

## Phases

| Phase | File | Outcome | Estimate (INFERRED) |
| --- | --- | --- | --- |
| 1 | [phase-1.md](2026-11-15-retrofit-url-to-preview-phases/phase-1.md) | Scaffold, configuration, CSP, vendored runtime, gate with evidence binding, decision record, CI handoff | 2 days |
| 2 | [phase-2.md](2026-11-15-retrofit-url-to-preview-phases/phase-2.md) | Store contract with leases, safe fetch, crawl jobs per destination, snapshot | 3 days |
| 3 | [phase-3.md](2026-11-15-retrofit-url-to-preview-phases/phase-3.md) | Score tool contract, deterministic score, visitor-owned analyses, pages, performance budgets | 3 days |
| 4 | [phase-4.md](2026-11-15-retrofit-url-to-preview-phases/phase-4.md) | Generator, private preview, consent-aware fetch guard, key panel, Retrofit's own agent, local §6 harness | 7 days |
| 5 | [phase-5.md](2026-11-15-retrofit-url-to-preview-phases/phase-5.md) | Write-confirmation spike (time-boxed, 1 day) | 1 day |
| 6 | [phase-6.md](2026-11-15-retrofit-url-to-preview-phases/phase-6.md) | Free inference with spend control, judge reserve and credit alert | 3 days |
| 7 | [phase-7.md](2026-11-15-retrofit-url-to-preview-phases/phase-7.md) | Supabase store, gate database, evidence analyzer, production peers, hosting, DNS, candidate deployment, production evidence, release | 5 days plus authorization time |

The estimates total about 24 working days. Starting on 2026-11-16, Phase 7 ends near 2026-12-18. That leaves about 3 weeks before 2027-01-11, including the holidays, for the second plan. This is an estimate, not proven contingency.

## Second plan: critical path (outline, not accepted scope)

Ordered by dependency. Dates are targets for planning, not commitments.

1. **Write-confirmation design**, from the Phase 5 spike (about 2026-12-04). Blocks every acting demo. Its design work can start in a separate session while Phases 6 and 7 run, once the owner accepts the spike.
2. **Owner bundle in source mode**: the generated network, manifest, content and site actions that an owner installs on their own origin. Depends on 1.
3. **Demo merchant sites** on `demo-*` hosts with installed bundles: cart and booking with confirmation, receipts and unknown-outcome handling. Depends on 1 and 2. This is the strongest judging proof (acting agent, two sites calling each other).
4. **Ownership claim** by meta tag or DNS record, gating the official bundle and badge. Depends on 2.
5. **Plan step** text on the results page, and the "we do it for you" contact. Independent.
6. **Feature freeze 2027-01-04.** Then the video (Juan explaining, no third-party trademarks), screenshots, Devpost text and the judge-code delivery check. Submission is an owner-authorized action before 2027-01-11 8:00 am PT.

## Oracles

- **Runtime validation:** vendored `validateNetwork` accepts every generated network and rejects the invalid fixtures.
- **Organizers' build:** `build_network.mjs` without `--check`, with `--runtime tools/agentic-web/runtime`, exits 0 for every generated network and Retrofit's own; non-zero for the invalid fixture. `--check` exits 0 for the committed Retrofit and peer network files.
- **Organizers' partner check:** `check_partner.mjs` exits 0 for `retrofit_guide` and `harbor_tours`, locally (Phase 4) and in production (Phase 7).
- **Spec §6 harness:** Playwright specs in Phase 4 (local) and Phase 7 (production), modeled on the organizers' cases L1 to L10 and C1 to C8 (`tests/linking/README.md:38-98`).
- **Golden scores:** `tests/fixtures/expected-scores.json`.
- **Address table:** `tests/fixtures/address-cases.json`.
- **Store contract suite:** `tests/store/contract.ts`, run against both adapters, including two clients on one backend.
- **Performance budgets:** `tests/perf/analyze-load.test.ts` (Phase 3).
- **Evidence analyzer:** `tools/release/analyze-evidence.mjs` with rejection fixtures (Phase 7).
- **Contract probe:** one recorded streamed tool-call exchange with real Otari (Phase 6).

## Stuck states and recovery

| State | Who sees it and what they see | How it ends | Test |
| --- | --- | --- | --- |
| Crawl job stays `crawling` because its function stopped | Visitor: "This analysis took too long. Try again." with Retry | A read marks the job failed when its lease (60 s) has expired and `updatedAt` is older than 90 s; Retry starts a new job; a late write from the old worker is discarded by its stale lease token | `tests/analysis/stale.test.ts` |
| robots.txt disallows Retrofit on a host | Visitor: "This site asks automated tools not to read it. Retrofit stopped and read nothing else." | Another URL; the owner can allow `RetrofitBot` | `tests/fetch/robots.test.ts`, `e2e/analyze-blocked.spec.ts` |
| robots.txt 5xx or timeout | Visitor: "Retrofit could not read this site's robots rules, so it stopped. Try again after HH:MM." | Cached 1 h, then retry allowed | `tests/fetch/robots.test.ts` |
| Per-client analysis limit (20 per hour) | Visitor: "You reached the limit of 20 analyses per hour. Try again at HH:MM." | Window expires | `tests/api/analyze.test.ts` |
| Global crawl capacity full (8 running or 1000 hosts per day) | Visitor: "Retrofit is busy. Your analysis starts in a moment." (queued), or "Retrofit reached today's analysis limit. Try again tomorrow." Agents get a 202 with the same text | A finishing worker or any analyze, status or score request dispatches the next queued job; the UTC day resets the daily cap | `tests/analysis/capacity.test.ts` |
| Queued job not started within 120 s | Visitor: "Retrofit is too busy right now. Try again in a few minutes." Agents get 503 with the same text and `retryAfterSeconds` 120 | A new request queues it again | `tests/analysis/capacity.test.ts` |
| Address is not a public website | Visitor: "This address is not a public website." | Another URL | `tests/fetch/guard.test.ts` |
| Generated network fails validation | Visitor: score, then "Retrofit could not build a working agent for this site." | Generator fix; reason kept in the job | `tests/generate/validate.test.ts` |
| Preview expired (analysis older than 7 days) | Visitor: "This preview expired on <date>. Analyze the site again." | New analysis | `tests/analysis/expiry.test.ts` |
| Visitor cookie missing or different (other device, cleared cookies) | Visitor: "This preview belongs to another browser. Analyze the site again to get your own." (same text for a nonexistent id) | New analysis; the shared crawl makes it fast | `e2e/privacy.spec.ts` |
| Key test fails (401, CORS, model not listed) | Key panel: provider-specific message | Visitor fixes the key or uses Advanced | `tests/keys/test-key.test.ts`, `e2e/key-panel.spec.ts` |
| Peer redirect, unapproved destination or artifact on another origin | Chat: "Retrofit blocked a request to <origin> that was not approved." | The visitor continues; the peer call fails closed | `e2e/redirects.spec.ts` |
| New provider key fails validation | Key panel: the provider message; the previous router (free path or provider A) stays active | Visitor fixes the key | `e2e/provider-switch.spec.ts` |
| `score_site` called while the score runs | Agent: "The score is still running. Call score_site again in 20 seconds with the same URL." | Agent calls again | `tests/agent/score-action.test.ts` |
| Free cap reached (session, client, public pool or ledger) | Chat and banner: "Retrofit's free AI is used up for <reason>. Paste your own key in AI settings to continue." | A key, or the window resets; judges use the reserve | `tests/inference/quota.test.ts`, `e2e/free-path.spec.ts` |
| Session cookie expired | Renewal every 30 min and on tab focus at `/api/inference/session` keeps the same session; if a call still fails: "Your free session expired. Reload the page." | Automatic renewal, or reload | `e2e/free-path.spec.ts` |
| Otari error, timeout or mid-stream failure | Chat: "The free AI provider did not answer. Try again, or use your own key." (HTTP 502, because the free path buffers the whole completion) | Retry by the visitor; the proxy never retries | `tests/inference/proxy.test.ts`, `e2e/free-path.spec.ts` |
| Reported usage above the reservation (overrun hold) | Visitors: "Retrofit's free AI is paused. Use your own key." Judges keep access while remaining credit allows. Owner: a GitHub issue "Free AI reservation overrun" with the reconciliation steps | The owner reconciles bound, prices, provider balance and outstanding reservations, then runs `pnpm ops:resume-free` (an authorized production action). Never reopens by itself | `tests/inference/hold.test.ts` |
| Inference counters unavailable | Chat: "Retrofit's free AI is not available right now. Use your own key." | Store recovers; no forwarding without a reservation | `tests/inference/proxy.test.ts` |
| Credit threshold crossed | Owner: a GitHub issue "Free AI credit threshold reached" in `juan294/retrofit` | Owner adds credit, lowers caps or accepts | `tests/ops/credit-check.test.ts` |
| Store unavailable in production | Visitor: "Retrofit is having trouble. Try again in a few minutes." `/api/health` `degraded` | Supabase recovers; no fallback to memory in production | `tests/store/supabase-failure.test.ts` |
| Gate database held, inherited or left by an interrupted run | Developer: the holder, or "Found a retrofit-gate stack this run did not create" with `pnpm gate-db:recover` | Holder finishes; recovery disposes only a stack that matches its own receipt and whose run is dead | `tests/tools/gate-db.test.ts` |
| Evidence stale or incomplete | Releaser: the analyzer names each missing, stale or failed item | Re-run the gate | `tests/release/analyze-evidence.test.ts` |
| Production evidence fails for the candidate deployment | Owner: the analyzer report; the release is not accepted or tagged | Remove the production alias (first release) or roll back (later releases) under the playbook, fix locally, new candidate | `tests/release/analyze-evidence.test.ts` (production mode) |
| Vendored runtime changed | Developer: `pnpm vendor:verify` names each file | `pnpm vendor:sync` from the recorded commit | `tests/vendor/verify.test.ts` |

## Consumer sweep

No application code exists. This plan defines five shared formats. Before each phase is accepted, run `rg -n "Snapshot|CrawlJob|Analysis|Store|SessionClaims|Ledger" src tests e2e tools` and confirm that the list is complete.

| Format | Producers | Consumers |
| --- | --- | --- |
| `Snapshot` | `src/lib/fetch/crawl.ts`, `src/lib/fetch/extract.ts` (Phase 2) | `src/lib/score/*` (3), `src/lib/generate/*`, `src/app/p/[id]/[...file]/route.ts` (4), vendored `public/preview-assets/content-actions.js`, `tests/fixtures/snapshots/` |
| `CrawlJob` (shared, per destination host) | `src/lib/crawl/jobs.ts` (2) | `src/lib/analysis/*`, `src/app/api/score/route.ts` (3), `src/lib/generate/*` (4) |
| `Analysis` (visitor-owned) | `src/lib/analysis/run.ts` (3, extended in 4) | `src/app/api/analyze/*`, `src/app/r/[id]/page.tsx` (3), `src/app/p/[id]/[...file]/route.ts` (4), `e2e/` helpers |
| `Store` contract | `src/lib/store/memory.ts` (2), `src/lib/store/supabase.ts` (7) | `src/lib/fetch/limits.ts`, `src/lib/crawl/jobs.ts` (2), `src/lib/analysis/*` (3), `src/lib/inference/*` (6), `src/app/api/health/route.ts`, `src/app/api/cron/*` (6, 7), `tests/store/contract.ts` |
| `SessionClaims` and `Ledger` | `src/lib/inference/token.ts`, `src/lib/inference/ledger.ts` (6) | `src/app/api/inference/*` routes, `src/lib/inference/quota.ts`, `src/app/api/cron/credit-check/route.ts` (6) |

## Risks

- **Specification churn.** Pinned commit, checksum manifest, re-read at Phase 4, 5 and 7 entry.
- **Vendored runtime churn.** No patches; only `Preview.tsx` touches its API.
- **Free-inference cost and Otari limits.** The ledger is Retrofit's own count; Otari's own balance or key budget is checked at Phase 6 entry. Credits may run out before 2027-01-18 if the public pool is set too high.
- **Judge code exposure.** If Devpost has no judges-only field, the code is public and the judge reserve can be spent by others within its own caps.
- **Inline styles allowed.** `'unsafe-inline'` for styles permits CSS injection if markup injection exists. Mitigation: hostile content and model-output rendering tests; scripts stay strict.
- **Fetch guard scope.** The guard covers `fetch`; CSP covers other request types (`img-src`, `frame-src`, `connect-src`).
- **Adapter depends on runtime internals.** The consent hook wraps `engine.requestConsent`, an internal method of the pinned runtime. A runtime update can break it; `e2e/redirects.spec.ts` and `e2e/spec6.spec.ts` fail in that case, and the vendor checksum blocks silent updates.
- **Billing assumptions.** The reservation bound assumes byte-level tokenization and bounded provider framing. Phase 6 probes it against Otari; an overrun holds the public pool until the owner reconciles. Without a provider-side per-key cap, a charge already made above a reservation can reach the judge reserve; the plan states this as a qualified guarantee for the owner to accept.
- **Cycle diagnostics.** The runtime prevents cycles silently (fact 20). The adapter turns its `composition_skip` trace event into a visible notice; this depends on the runtime's trace API, checked at Phase 4 entry.
- **No streaming on the free path.** Visitors on the free path see the answer at once when it is complete, not word by word. BYOK keeps streaming.
- **Serverless time limits.** Crawl budget 45 s, upstream timeout 45 s, `maxDuration` 60 s.

## Review record

### R1 to R24 (in-session review, revision 2)

All resolved in revision 2 and kept in this revision: R1 vendored runtime for the oracles; R2 build oracle without `--check`; R3 manifest in `public/`; R4 §6 coverage (now production, Phase 7); R5 evidence analyzer; R6 fixtures switch off Vercel only; R7 absolute `originUrl`; R8 cookie authentication; R9 published default router; R10 runtime storage cleared; R11 bridge CSP; R12 no page text in instructions; R13 robots per host; R14 defined limits; R15 snapshot with the analysis; R16 same-origin checks and judge access (now reserve); R17 disposable gate stack (now R32); R18 `rpi-tool-design`; R19 origin recording; R20 origin decision (now owner decision); R21 provider table from the runtime; R22 open values decided; R23 CLI first deploy; R24 broader leak tests and SSRF ranges.

### R25 to R40 (second assessment)

| ID | Sev | Finding | Disposition in revision 3 |
| --- | --- | --- | --- |
| R25 | S2 | Renewal at `/api/session` cannot receive a cookie scoped to `/api/inference` | Session route moved to `/api/inference/session`; browser test keeps `sid`, pool and spent quota across renewal, two tabs and UTC rollover (Phase 6) |
| R26 | S2 | Cached ids shared previews between visitors | Shared `CrawlJob` separate from visitor-owned `Analysis`; visitor cookie checked on every result, status and artifact route; score API returns no analysis ids; two-context test (Phases 3 and 4) |
| R27 | S2 | Fixture harness could not run | Fixture URL policy in the real validator; route path `src/app/test-fixtures/`; exact test-only `connect-src` entry; production refusal tests (Phases 1, 2 and 4) |
| R28 | S2 | Runtime styles blocked by the nonce style policy | `style-src 'self' 'unsafe-inline'` (fact 9); dynamic rendering for nonces; zero-violation listener in every browser test (Phases 1 and 4) |
| R29 | S2 | Peer redirects bypass consent | Fetch guard with `redirect: "error"` and an origin allowlist; matching `connect-src`; redirect and third-origin tests (Phase 4) |
| R30 | S2 | Call caps did not bound spend | Request allowlist, `n` forced to 1, input and output bounds, in-flight caps, reservation and ledger, provider-side limit where available (Phase 6) |
| R31 | S2 | Deduplication and leases incomplete | `putIfAbsent`, lease tokens, fenced writes; contract tests for both adapters with two clients (Phases 2 and 7) |
| R32 | S2 | Gate database could reset another run's stack | Machine-wide lock and receipts outside worktrees; inspect before start and reset, verify before disposal; recovery command; tests (Phase 7) |
| R33 | S3 | Single-origin reasoning and `strict-dynamic` | Owner decision: Retrofit is the isolated key origin with first-party code only; `'strict-dynamic'` removed; renderer audit and hostile output tests (Phases 1 and 4) |
| R34 | S3 | Judge capacity not guaranteed | Owner decision: reserve, hard caps, judge code delivery, credit alert, BYOK fallback; release and submission acceptance item (Phases 6 and 7) |
| R35 | S3 | Evidence producers and freshness undefined | Begin and seal steps, Vitest projects and reporters, coverage bar in the gate, test identities in the analyzer (Phases 1 and 7) |
| R36 | S3 | Redirect convergence bypassed crawl exclusivity | Crawl job per destination host with join; leased pacing for every contacted host (Phase 2) |
| R37 | S3 | RPC function privileges untested | `security invoker`, empty `search_path`, explicit `EXECUTE` grants, RPC tests per role (Phase 7) |
| R38 | S3 | No performance budget | Polling backoff, compact status, one store read per status, global crawl caps, score wait 25 s, upstream timeout 45 s, load test (Phases 3 and 6) |
| R39 | S3 | Release scope conflicted with the profile | Owner decision: production peer `demo-harbor` and production §6 before release (Phase 7) |
| R40 | S3 | Second plan risks deferred | Owner decision: Phase 5 spike and the critical path above |

### Revision 3 assessment (revision 4 dispositions)

| ID | Sev | Finding | Disposition in revision 4 |
| --- | --- | --- | --- |
| R29 follow-up | S2 | Guard allowed every configured peer, not only approved ones | Guard records approvals from the engine's `requestConsent`; a peer origin needs policy and consent; router origin limited to its API paths; same-origin artifact fetches use `redirect: "error"`; A-to-B and router-as-artifact-host tests (Phase 4) |
| R30 follow-up | S2 | Byte/3 estimate is not a bound | Reservation is a byte-level upper bound plus framing; strict nested schema; overrun suspends the public pool and alerts; high-density probe; tests for usage above reservation, missing usage, disconnect and concurrency (Phase 6) |
| R39 follow-up | S2 | Cycle and over-budget left local; production evidence after "release" | All §6 cases in production with published conformance peers and a scripted model inside the test browser; candidate deployment, production evidence bound to deployment and commit, analyzer production mode, then acceptance and tag (Phase 7) |
| R41 | S2 | Guard blocked provider validation | Explicit `authorizeProvider` from the key panel; real-browser tests for free to BYOK, provider A to B and failed validation (Phase 4) |
| R42 | S2 | Runtime ignores an SSE error event | Free path buffers the completion and fails with HTTP 502; browser test with a partial upstream answer then failure (Phase 6) |
| R43 | S2 | Queued API-only jobs had no dispatcher | Store queue primitive; dispatch on worker completion and on every request; 120 s queue expiry; API-only test with no polling (Phases 2 and 3) |
| H1 | S3 | Lint rule forbade the Supabase failure test's location | Explicit allowlist entry for `tests/store/supabase-failure.test.ts` (Phase 1) |
| H2 | S3 | Load test needed a server but sat in the unit suite | Vitest `perf` project with its own server lifecycle on port 3014, gate position after `pnpm build` (Phases 1 and 3) |
| H3 | S3 | Load test needed ten hosts but fixtures allowed two | `<label>.fixture.test` host names, mapped to loopback in fixtures mode for Node and for Chromium (Phases 1 and 2) |
| H4 | S3 | Universal CSP fixture conflicted with expected violations | Per-test `expectCspViolations` with an exact list; anything unexpected or missing fails (Phases 1 and 4) |

### Revision 4 assessment (revision 5 dispositions)

| ID | Sev | Finding | Disposition in revision 5 |
| --- | --- | --- | --- |
| R44 | S2 | Proxy schema rejected the runtime's tool messages (`name`) | Schema accepts a validated `name` on tool messages (fact 19); request bodies captured from the vendored runtime in Phase 4 are replayed through the schema; free-path e2e runs a delegation and a site action followed by the next model call (Phases 4 and 6) |
| R39 cycle | S2 | Cycle case expected an error the runtime does not throw | Cycle case proves prevention: the back edge is absent from the model's tool list, no recursive fetch, a `composition_skip` event, and a visible adapter notice; an unknown-tool error does not count (Phases 4 and 7) |
| R30 hold | S2 | Overrun reopened at midnight; reserve guarantee overstated | Persistent hold until owner reconciliation and `ops:resume-free`; judge budget from remaining credit; provider-backed isolation if Otari has per-key limits, else a qualified guarantee accepted by the owner (Phase 6) |
| A1 | S3 | `peerOrigin` is `host:port` without a scheme | Mapped to exactly one configured origin, else no approval; scheme and port tests (Phase 4) |
| A2 | S3 | Router probe path is the router's origin root | Guard allows `GET <router origin>/agent-manifest.json`; recorder test uses that path (Phase 4) |

## Handoff

- **Objective and scope:** this plan, Phases 1 to 7. Approved scope so far: planning only. No implementation, push, deployment, provider account, credential or DNS action is authorized.
- **State at writing:** branch `develop`, revision 4 at `09fe016`; `origin/develop` at `44c5325`; worktree `/Users/juan/code/retrofit`. Spec commit `63a956c`. Neuro SAN reference commit `71b9f41`.
- **Evidence limits:** listed under "Specification read". Next.js 16 behavior, cookie behavior in real browsers, the HOCON reference bodies and Otari's balance and key-budget features were not checked; the phases that depend on them verify them first.
- **Decisions:** owner decisions and planner decisions above.
- **Review:** R1 to R44, H1 to H4 and A1 to A2 dispositions above. Revision 5 has not had its own independent review.
- **Owner acceptance items inside phases:** the `score/v1` weights (Phase 3), the write-confirmation approach (Phase 5), and the judge-reserve guarantee level (Phase 6).
- **Overlay:** none present; no override applied.
- **Next step:** owner acceptance. On acceptance, start Phase 1 in a worktree with `/rpi-implement`.
