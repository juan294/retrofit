# URL-to-preview revision 3: acceptance review

Reviewed 2026-11-15 against `develop` at `f5cbb6fbde692ae4a15cb7372882241552ab7e99`, clean at entry, in `/Users/juan/code/retrofit`. Recommendation: **revise the remaining contract defects before acceptance**. Phase 1 has not started.

## Scope and evidence

Read the parent plan, all seven phase files and the second assessment completely. Reused unchanged controlling instructions, brief, release and resource contracts from the preceding assessment. Applied `rpi-assess`; no overlay or override. Queried the local Graphify index and confirmed the relevant claims against documents and pinned runtime source. Two independent read-only investigations covered runtime/CSP/consent and inference/storage/release. Both returned results.

Runtime references below mean `cognizant-ai-labs/agentic-web` at `63a956cf4653f610b1c238c70946f4d7647d17a8`, under `skills/agentify-website/`. Phase references mean files in `docs/plans/2026-11-15-retrofit-url-to-preview-phases/`. This is source and contract review, not application verification. No browser, live provider call, service, database or deployment was run.

## Earlier findings addressed at plan level

The cookie renewal path and its stronger browser oracle address R25. Visitor-owned analyses with route authorization address R26. Routable fixture paths and explicit localhost URL handling address the original R27 failures. The chosen style policy resolves the specific stylesheet incompatibility in R28; rendering remains a required phase proof. Atomic join, leases and fenced-write requirements address the original R31 API gaps. Machine-wide coordination and inspection before reset address the original R32 ordering/concurrency defects. Explicit function privileges address R37.

The first-party origin decision, reserve policy and write spike are recorded decisions; this review does not reopen them. Next.js nonce behavior, Otari features and the spike outcome can reasonably remain phase-entry/acceptance proofs. R40 now has an explicit critical path. None of these statements certifies implementation that does not yet exist.

## Remaining material findings

### R29 remains partial — configured peers are not consented destinations (S2)

Phase 4:48-49 allows all `manifest.allowed_peers`, while the runtime obtains consent for an individual peer. An approved peer A can supply an absolute `hocon` URL on configured but unapproved peer B. Pinned `runtime/engine.js:193-195` resolves and fetches that URL without a second consent operation; the wrapper permits it because B is configured. Tests in Phase 4:77-79,98 use a third origin absent from the allowlist, so they do not distinguish configuration from consent.

**Correction:** keep allowed policy and granted consent distinct. Either restrict a peer's artifacts to its already-approved origin, or integrate destination-specific approval before every new artifact origin. Add A-to-B absolute-artifact tests where both origins are configured but only A is approved, plus a case targeting the active router as an artifact host. Assert zero contact until the appropriate approval. Also define redirect handling for same-origin runtime artifact fetches: Phase 4:49 leaves those unchanged, which does not support the summary's claim that redirects always fail.

Rejecting cross-origin redirects is useful and addresses the original redirect-following path; it does not cover the absolute-URL path. See [pinned compilation code](https://github.com/cognizant-ai-labs/agentic-web/blob/63a956cf4653f610b1c238c70946f4d7647d17a8/skills/agentify-website/runtime/engine.js).

### R30 remains partial — estimated reservations cannot guarantee a hard cap (S2)

Phase 6:66 reserves input cost using `input bytes / 3`. This is an estimate, not a demonstrated upper bound on billable tokens, including chat/tool framing. Phase 6:92 tests reconciliation downward only. If actual billed usage exceeds the reservation, or the connection ends without usage, the ledger may understate spend and the public pool can consume funding intended for judges.

**Correction:** reserve a conservative bound for the exact supported request schema, provider/model and price, including framing and every billable component. An exact supported tokenizer with bounded overhead or a deliberately conservative maximum-request charge are possible approaches; choose one and document its assumptions. Validate nested text/tool schemas so unsupported multimodal or other unbounded content cannot bypass the bound. Test high-token-density input, reported usage above the estimate, missing usage, disconnects, and concurrent near-limit calls. Reconciliation must not pretend a post-hoc debit can undo already incurred spend.

The [Qwen tokenizer documentation](https://github.com/QwenLM/Qwen/blob/main/tokenization_note.md) illustrates byte-level tokenization falling back to individual bytes; it is not verification of the exact hosted Qwen3.8 model. The relevant finding is the plan's absence of a proved bound, not a measured Otari overcharge. A provider-side cap remains useful additional protection if available.

### R39 remains open — production scope and release ordering contradict the decision (S2)

The parent plan:9,66 requires every §6 check in production before first release. Phase 7:108 explicitly keeps cycle and over-budget cases local. Phase 7:101 runs the analyzer and calls the operation a release, while production checks occur under post-release verification at Phase 7:104-122. The analyzer in Phase 7:60-70 has no explicit deployed-candidate production-evidence input.

**Correction:** specify all required production cases, including how negative cases are exercised safely without leaving test bypasses enabled. Distinguish an explicitly authorized candidate deployment needed to obtain production evidence from final release acceptance/tagging. Bind the production reports to that deployment and commit, analyze them, then finalize the release. If any cases remain local, record an explicit narrower owner decision instead of claiming the current requirement is satisfied.

### R41 — the fetch wrapper blocks normal provider switching (S2)

Phase 4:48-49 wraps all `window.fetch` calls and allows only the active router plus configured peers. Phase 4:63 immediately tests a newly pasted provider using `/models`, before the reboot that selects it (Phase 4:64; Phase 6:86). With free inference active, the active router is Retrofit itself. The new provider's validation request is therefore rejected. Provider A to provider B has the same conflict.

**Correction:** define an explicit user-selected provider transition that authorizes validation to that exact endpoint before the validation call, with clear behavior on failure, successful activation and forgetting a key. Keep the wrapper lifecycle safe on reboot/unmount. Test free-to-BYOK and A-to-B in a real browser with the wrapper installed, including failed validation; do not prove this only by mocking the key-panel fetch in isolation.

### R42 — the unchanged runtime ignores the planned streaming error (S2)

Phase 6:71 emits an error event and closes the stream after an upstream failure. Pinned `runtime/llm.js:174-178` ignores JSON without `choices`; `:209` ignores `event:` lines; `:223` returns accumulated content on graceful EOF without requiring a finishing marker. A conventional SSE error followed by close can therefore appear as a completed partial answer, rather than the promised visible failure.

**Correction:** specify a transport/adapter failure mechanism the unchanged client actually recognizes, or a separately reviewed runtime change. Add a browser test that consumes a partial streamed answer followed by failure and asserts a failed outcome, visible recovery text and no retry. Do not encode the error as ordinary model content. [Pinned stream reader](https://github.com/cognizant-ai-labs/agentic-web/blob/63a956cf4653f610b1c238c70946f4d7647d17a8/skills/agentify-website/runtime/llm.js).

### R43 — queued public API work lacks a progress mechanism (S2)

Phase 3:67 schedules queued jobs when a visitor status route is polled. The public `/api/score` path (Phase 3:73) returns no analysis ID and its agent callers never poll that route. Once capacity is full, an API-only queued request has no documented dispatcher after a slot frees. Repeating `startOrJoinCrawl` joins the existing job; Phase 2:56-61 does not define a claim-and-dispatch operation for that queued job.

**Correction:** make progress independent of a private preview's polling. For example, atomically claim eligible queued work on score retries and worker completion, or use an explicitly owned dispatcher. Test more API-only jobs than available slots, with no browser/status polling, and prove eventual execution or a truthful bounded rejection. This needs an explicit liveness contract, not necessarily a new queue service.

## R35/R38: smaller gate contradictions to correct

- **Failure-test placement:** Phase 1:27 prohibits importing the Supabase adapter outside `tests/db/**`, but Phase 7:83 requires the closed-port adapter failure test at `tests/store/supabase-failure.test.ts`. Permit this non-database test explicitly or give it a compatible location/project without losing the failure oracle.
- **Load-test lifecycle:** Phase 3:92 places a `next start` load test in the unit project, which runs before the build and Playwright server setup in Phase 1:102. Give the load test a named server lifecycle and gate position after build. Do not rely on a developer's existing server.
- **Distinct fixture hosts:** the load test requires ten distinct destination hosts, but the URL exception in Phase 2:29 accepts only `localhost` and `127.0.0.1`; changing ports does not create distinct hostnames. Define the test-only host mapping needed to exercise the global concurrency limit through the real validator.
- **Expected CSP violations:** Phase 1:29 fails on every violation, while Phase 4:94 allows named expected violations in hostile-output tests. Define a narrow per-test expectation mechanism; ordinary tests must still reject every unexpected violation.

These are bounded corrections to the harness, not reasons to add more phases. Existing report producers, coverage and suite separation are substantial improvements over revision 2.

## Disposition and handoff

Do not mark revision 3 accepted yet. Resolve R29, R30 and R39 as above, add R41–R43 to the plan review record, and reconcile the four gate contradictions. Keep ordinary phase-dependent proofs in their phases; this review does not request a premature application build or provider setup.

Only this assessment was added, locally and uncommitted. The plan and previous assessment were not edited; no push, issue, credential action, service allocation or implementation occurred. No resource cleanup is outstanding. Both independent reviews completed. Evidence consists of document/source inspection and primary-source reading, not executed application tests. Next step is a targeted contract revision and owner acceptance before Phase 1 in a separate session.
