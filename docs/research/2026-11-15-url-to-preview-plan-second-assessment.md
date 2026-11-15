# URL-to-preview plan: second assessment

Reviewed 2026-11-15. Recommendation: **revise before acceptance**. This is an assessment of a proposed contract, not a report of defects observed in a running application.

## Scope and evidence

Question: is the revised plan implementable, safe, verifiable and sufficient for its proposed first release?

Baseline: `develop` at `4161197c40bc55aeed0371a48803e6dacb38eff7`, clean at review entry, `/Users/juan/code/retrofit`. Reviewed the parent plan and all six phase files, accepted brief, briefing, controlling rules, release playbook/profile, and relevant verifier source. Graphify was queried through this repository; its results were chiefly workspace machinery, so source documents govern this assessment. No project assessment overlay exists.

Two bounded independent read-only investigations covered runtime/key/conformance assumptions and data/concurrency/gate behavior. Both returned findings; neither allocated services or edited files. Runtime source was verified in the existing local specification clone at `63a956cf4653f610b1c238c70946f4d7647d17a8`. References below to upstream files mean that pinned commit in `cognizant-ai-labs/agentic-web`, under `skills/agentify-website/` unless stated otherwise.

Criteria: privacy and key isolation, consent, spend and resource bounds, runnable acceptance tests, concurrency correctness, release authority and achievable scope. Findings continue the plan's R1–R24 numbering. All findings below are unresolved; none is an accepted exception. S2 denotes a material correctness/security contract issue; S3 denotes a narrower gap or risk requiring review. No S1 incident or demonstrated compromise is claimed.

## Corrections needed before accepting the contract

### R25 — S2: the renewal endpoint cannot receive its session cookie

Phase 5:34 sets `Path=/api/inference` while creating and renewing at `/api/session`; Phase 5:58 promises renewal without changing identity/counters. The browser excludes that cookie from `/api/session`, so the handler cannot authenticate the old `sid` using the described mechanism. This also undermines quota continuity and judge-pool continuity. The existing browser test checks only that the cookie changes, which could pass after creating an entirely new session.

Move renewal within the cookie path, or deliberately broaden the path and review its effects. Test a real browser renewal retaining `sid`, pool and consumed quota, including multiple tabs and UTC rollover. A local standard-library cookie-policy probe confirmed `/api/session` receives no cookie while `/api/inference/v1/chat/completions` does; no browser app was run. See [cookie path rules](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie).

### R26 — S2: shared cached IDs defeat private previews

Phase 2:25 maps an origin to a ready record ID; Phase 3:52 returns it to any subsequent caller. Phase 3:62 and Phase 4:39 specify no visitor authorization on status/results/artifacts. Random IDs, `noindex`, absent CORS and private cache headers do not prevent a second visitor submitting the same site and receiving the first visitor's ID.

Separate reusable public crawl data from visitor-specific preview access. Define access checks for every result, status and artifact route, and prevent the public score endpoint exposing private preview capabilities. Test two isolated browser contexts requesting the same URL: they may share crawl work but must not obtain each other's private preview access. If the intended product is merely an unlisted shared preview, that needs an explicit change to the accepted privacy promise.

### R27 — S2: the fixture harness cannot run as written

Three independent contradictions require correction:

- Phase 2:20 refuses IP literals, hosts without a public suffix and ports other than 80/443. Phase 2:21 only relaxes address classification, while fixtures use localhost/IP literals and ephemeral ports (Phase 2:29,104). Add a narrowly scoped fixture URL policy through the real validator; keep production refusal tests.
- Phase 4:72 uses `src/app/__fixtures/`. Next excludes underscore-prefixed private folders from routing. Use a routable test path or encoded underscore, and assert the endpoints exist under `next start`. See [Next project structure](https://nextjs.org/docs/app/getting-started/project-structure).
- Phase 1:66 permits connections only to self plus Phase 4 provider routers; Phase 4:71,90 requires fetching `localhost:3011`. Add an exact test-only peer allowance. Prove decline sends nothing and approval actually loads the peer, without bypassing CSP in the browser test.

### R28 — S2: the unchanged runtime conflicts with the style CSP

Phase 1:66 requires nonce-only inline styles. Pinned upstream `runtime/ui.js:278-281` appends a `<style>` containing `BASE_CSS` without a nonce. The runtime UI's styles will be blocked under the stated policy. Landing-page header checks do not test this.

Choose a compatible mechanism, such as a pinned style hash or reviewed stylesheet extraction, and include runtime layout plus CSP-violation assertions. Keep the runtime checksum policy consistent with that decision. Next nonce propagation also needs dynamic rendering; specify and test hydration, navigation and caching behavior rather than only checking the response header. See [Next CSP guidance](https://nextjs.org/docs/app/guides/content-security-policy).

### R29 — S2: consent tests omit redirects supported by the runtime

Pinned specification `docs/worldwide_agentic_web_mvp_spec.md:394-395` requires a different-origin redirect to be evaluated as a new destination. Pinned `runtime/remote.js:6-17` uses plain `fetch`, which follows redirects. Phase 4:90 tests approval of the initial peer only. An approved peer can redirect before the runtime obtains approval for the new origin; CSP may block some destinations but is not destination-specific consent.

Add adversarial manifest and network redirects and absolute third-origin network URLs. Require zero contact with an unapproved destination. Decide a compatible containment or upstream repair strategy before retaining both the unchanged-runtime promise and the full consent claim. This is a source-backed gap; no live exploit was attempted. [Pinned upstream loader](https://github.com/cognizant-ai-labs/agentic-web/blob/63a956cf4653f610b1c238c70946f4d7647d17a8/skills/agentify-website/runtime/remote.js).

### R30 — S2: inference call caps do not establish spending caps

Phase 5:47 validates only model, a messages array and optional tools. Phase 5:20 bounds output tokens but gives no input token/byte bound, message/tool limits, concurrency limit, or explicit treatment of fields such as `n`. Client-side agent step limits are bypassable by direct endpoint calls. Same-origin headers are browser protections, not authentication against scripted clients.

Specify a strict upstream request allowlist, force a single completion, bound messages/tools/input and output, cap in-flight requests, and reserve cost before forwarding. Define an enforceable maximum daily spend and provider-side limit where available. Test oversized inputs, unknown fields, parallel near-limit requests, disconnects and counter failures. A single streamed tool-call probe establishes protocol shape, not operational cost or sustained availability.

### R31 — S2: running-job deduplication and leases lack the necessary state

Phase 2:17 makes lock acquisition return only a boolean; Phase 3:54-56 creates a queued record and launches background work but promises to return an already-running ID when that work later encounters a lock. There is no atomic running-ID registration from which to obtain that result before returning the response.

Define atomic acquire-or-join before scheduling, with a work ID separate from private preview access. Return a lease token and release only if it still owns the lock. Otherwise an expired worker can release a successor's lease. Test concurrent cold requests, expiry/reacquisition/late release, late completion after a stale failure, and acquisition through two Store clients. These should be contract tests for both adapters.

### R32 — S2: gate database ownership is checked after reset

Phase 6:31 fixes one project identity and port block, but Phase 6:39 locks a worktree-local path. Two worktrees can acquire different lock files and target the same database. Step 3 resets before step 4 checks ownership (Phase 6:41-42), contrary to the resource contract.

Use unique concurrent task identities/ports or an effective shared allocator with documented serialization. Inspect existing daemon, resource IDs, workdir, ownership and consumers before start/reset, then verify again before disposal. Never replace an existing ownership receipt just to match the new invocation. Test two worktrees, an inherited stack, replaced resources, interruption and cleanup failure. Plan acceptance cannot authorize disposal of a different task's data.

## Further required review

### R33 — S3: single-origin justification overstates the constraint and protection

The parent's single-origin decision cites upstream `runtime/action-transport.js:12-19`. That code requires the runtime and executable action assets to share an origin; it does not require the marketing/scoring application to share that origin. The original separate panel/runtime origin remains technically plausible if its preview assets/actions are co-hosted there.

Also, Phase 1:66 uses `strict-dynamic`: trusted scripts can load further scripts, so the absence of third-party host entries is not an absolute third-party-script prohibition. See [MDN's trust propagation rules](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/script-src). Compare the simpler single-origin design against the smaller key-bearing surface of an isolated origin. Either can be chosen, but CSP is not equivalent to origin isolation. Include hostile content and model-output rendering tests, and audit the vendored renderer as well as React's `no-danger` rule.

### R34 — S3: judge availability is not guaranteed by a second counter

Phase 5:25-26 still imposes judge session/day limits; both pools use the same funded Otari account. A code in submission text is not proof of judge identity if that text is public. The brief's unrestricted judge-access requirement and the claim that judges remain unaffected need a precise delivery and capacity decision.

Define how judges receive access, whether the code is public, reserved credit capacity through January 18, monitoring and a recovery path if the provider or credits fail. Keep judge access a release/submission acceptance item. Live Devpost rules could not be refreshed in this review (HTTP 403); this finding uses the repository's accepted requirement, not a new interpretation of contest rules.

### R35 — S3: evidence producers, freshness and suite boundaries are incomplete

Phase 6:53 consumes `vitest.json`; Phase 1:23-26 specifies plain `vitest run` and only configures Playwright JSON. Coverage is reported separately (Phase 1:104) but absent from the declared gate (Phase 1:88), despite the release playbook requiring it. Phase 6:70 puts a database-required test in the normal test tree, yet normal tests run before `test:db` provisions its stack.

Define actual report producers and explicit unit/database test projects without silent skips. Bind each report to the same attempt, candidate and command; the installed `.rpi/scripts/rpi-verify.py:163-210` already supplies an attempt and candidate identity but does not itself bind arbitrary report files. Reject stale successful reports from earlier attempts and check concrete safety test identities, not just the presence of a passing file. Include required fetch-guard and proxy-budget tests in the analyzer inventory.

### R36 — S3: redirect destinations can bypass crawl exclusivity

Phase 2:65 locks the input host and Phase 2:66 changes to the redirected host. Different inputs can converge on one destination and hold different locks. Define destination lock transfer/join and atomic pacing for every host contacted, including robots and probes. Test two input origins redirecting to one destination.

### R37 — S3: SQL function access is outside the planned privilege tests

Phase 6:22 adds atomic RPC functions; Phase 6:23,71 test table access but do not specify function security mode or `EXECUTE` privileges. This is not proof of an exposed function. Specify invoker/definer behavior, safe search paths where applicable, and explicit function privileges. Exercise direct RPC calls as `anon`, `authenticated` and `service_role` as well as table operations.

### R38 — S3: operational performance has no measurable acceptance budget

Phase 3:63 holds a score request for up to 50 seconds; Phase 3:65 polls every 1.5 seconds. A 45-second crawl produces roughly 30 polls per visitor, each potentially a database read. There is no concurrency/load oracle, compact status response contract, stop/backoff rule, or cap on total public crawl work across distributed clients. Nonce-rendered pages also carry a dynamic-rendering cost.

Set modest measured budgets for concurrent analyses, status response size, datastore calls, end-to-end latency and aggregate crawl work. Test slow sites, many viewers of one job and datastore latency. Phase 5:27 gives Otari a 60-second timeout while Phase 6:64 gives the whole function 60 seconds: reserve time for validation, counters and error delivery, and define mid-stream failure/cancellation behavior. [Vercel documents that background work shares the function lifetime](https://vercel.com/docs/functions/functions-api-reference/vercel-functions-package).

### R39 — S3: release scope conflicts with the existing prerequisite

Phase 6:108 leaves production two-origin conformance open, while `.rpi/release-profile.json` lists conformance under `required_before_first_release`. Local proof is useful, but a specially modified test caller does not prove the published production caller can link. Decide whether Phase 6 is an explicitly limited milestone with a revised release contract, or move the production two-origin proof before the first release. Do not let an analyzer accept a required item that remains open.

### R40 — S3: the schedule defers the highest-value demo risks

The 15–19 working-day sum is arithmetically correct. It is an estimate, not evidence that the remaining period is enough. The second plan contains ownership, bundles, safe write confirmation, merchant integration, production linking and submission assets: much of the product's differentiation and judging proof. The current runtime's write behavior is already identified as a concern in the parent plan.

Outline that critical path and its dependencies before treating the remaining 3–4 weeks as contingency. Put an early technical decision/proof for confirmed writes and production linking ahead of optional polish. No implementation or second-plan acceptance is implied by this recommendation.

## Recommended disposition and handoff

Revise R25–R32 before accepting the plan. Give R33–R40 explicit corrections or owner-reviewed dispositions, with release-critical items completed before publication. Keep the deterministic generator, synthetic score oracles, direct-provider BYOK and candidate-bound checks: they remain useful foundations. The findings do not require abandoning Next.js, Otari or Supabase.

The existing R1–R24 remedies were not exhaustively re-proven as executable checks; the application does not exist yet. The upstream version was pinned and inspected, not updated. No credentials, external mutations, deployments, database allocations or implementation changes occurred. Only this assessment document was added, uncommitted. No full application gate or live Otari call ran. No task services need cleanup. The inherited Rex session ID was unavailable; `rex whoami` did not identify a replacement pane, so no unrelated session was renamed.

Next action: revise the plan and acceptance tests, then request owner acceptance of the resulting concrete contract. Phase 1 has not started. A future implementer must revalidate the checkout, specification pin and relevant primary-source behavior.
