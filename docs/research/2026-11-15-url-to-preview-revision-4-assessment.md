# URL-to-preview revision 4: acceptance review

Reviewed 2026-11-15 at `09fe0167cf53b3dd3ff2d91293a7d6ef4a68423e`, branch `develop`, `/Users/juan/code/retrofit`, clean at entry. Recommendation: **three targeted corrections before full-plan acceptance**. No implementation started.

## Evidence and scope

Applied `rpi-assess`, with no project overlay or override. Reviewed the revision diff against `f5cbb6f`, the complete revised inference phase, and the changed consent, queue, harness and release contracts, reusing previous complete reads of unchanged text and controlling instructions. Queried the repository's local graph and confirmed findings against documents and runtime source. An independent read-only reviewer checked runtime integration and the production fixtures; its results were inspected.

Upstream source references below are under `skills/agentify-website/` in `cognizant-ai-labs/agentic-web` at the pinned commit `63a956cf4653f610b1c238c70946f4d7647d17a8`. Phase references mean `docs/plans/2026-11-15-retrofit-url-to-preview-phases/phase-N.md`.

## Improvements accepted at plan level

The engine hook is accessible: `runtime/index.js:88-95` returns the engine, and `runtime/engine.js:365` dispatches consent dynamically through that instance. The separate provider-validation permission addresses R41. Buffering the upstream response before returning HTTP success addresses R42 because `runtime/llm.js:128-131` rejects non-OK HTTP responses. Queue dispatch on worker completion and requests addresses the original R43 dependency on visitor polling. The separate performance project, fixture hosts, lint exception and explicit expected CSP violations address H1–H4.

The production deployment/evidence/analyzer/tag ordering addresses the earlier R39 ordering gap. Publishing an invalid fixture alongside valid networks does not by itself invalidate the partner check: `scripts/check_partner.mjs:365-374` selects the requested network and `:385-420` validates that entry. Phase-dependent nonce, provider and browser behavior still require their planned checks; none is claimed to have passed here.

## R44 — S2: normal runtime tool messages fail the strict proxy schema

Phase 6:64 permits `tool_call_id` on tool messages and forbids other keys. Pinned `runtime/runner.js:585` emits:

```js
{ role: "tool", tool_call_id: result.id, name: result.name, content: result.content }
```

`runtime/llm.js:85-92` sends the messages unchanged. The next free-path model request after a tool result therefore receives HTTP 400 under the specified schema. This affects both grounded site actions and agent delegation.

**Correction:** allow a bounded, validated `name` field on tool messages, or explicitly normalize this known runtime field before validating and forwarding. Preserve rejection of genuinely unknown fields. Add a proxy integration test using the exact multi-step conversation emitted by the vendored runtime, including delegation, site action result and the subsequent model call. A hand-authored "valid tool-call conversation" that omits `name` will miss this incompatibility.

## R39 follow-up — S2: the cycle fixture's oracle does not match runtime behavior

Phase 7:59 defines `harbor_loop` calling back to the caller network; Phase 7:127 expects a cycle error. But `runtime/runner.js:168-174` detects already-visited remote references when building the tool table, removes the back-edge tool and emits `composition_skip` with reason `already visited in this request`. Normal execution does not reach the later cycle exception. Forcing the removed function name from the scripted model would exercise an unknown-tool error instead.

**Correction:** explicitly test cycle prevention and its visible diagnostic. Prove the back edge is suppressed, no recursive contact occurs, and the user sees a clear cycle-prevention message, adding a small adapter presentation of the trace event if needed. Alternatively, demonstrate a fixture that actually reaches the intended cycle-error path. Keep the production case required, and do not count an unknown-tool failure as cycle evidence. This is a test/integration correction, not a reason to discard the runtime.

## R30 follow-up — the overrun response does not preserve an absolute reserve guarantee

The revised byte-based bound is substantially more conservative than bytes/3. However, Phase 6:74-80 still assumes that serialized request bytes plus fixed allowances cover the provider's complete billable input. A byte-level tokenizer bounds the bytes it actually tokenizes; it does not establish the size of provider-added framing, transformations or all billable components. The four probes in Phase 6 are useful empirical checks, not a universal proof of those assumptions.

More concretely, Phase 6:98 and the ledger test suspend the public pool only until the next UTC day after an observed overrun. An overrun is evidence that the bound was false. Automatically reopening with the same bound repeats the fault. Any charge already above the reservation may already have consumed credit intended for judges; an alert cannot reverse that charge.

**Correction:** persist a fail-closed hold until the bound, prices and actual remaining balance have been reconciled and the owner authorizes resumption. Include outstanding reservations in that reconciliation. Test that the hold survives UTC rollover and process restart, and that judge availability reflects remaining credit instead of asserting it is unaffected. Before Phase 6 acceptance, either establish a provider-backed isolation/cap and justified billing bound, or explicitly obtain acceptance of a qualified reserve guarantee. Do not describe post-hoc detection as proof that the reserve can never be touched. The provider research can remain in Phase 6; the hold behavior and truthful guarantee belong in this plan.

## Two integration details to pin during Phase 4

- `info.peerOrigin` is actually `URL.host`, without the scheme (`runtime/runner.js:33-34,428`). Map it uniquely to a configured full origin and fail closed if ambiguous. Test scheme/port distinctions; do not parse the host string as though it were already an absolute URL.
- The runtime router probe uses `<router origin>/agent-manifest.json` (`runtime/engine.js:41-44`), while Phase 4:52 names `<router base>/agent-manifest.json`. Use the actual pinned request shape in the fetch guard and its recorder test.

These are narrow adapter details, not additional architecture decisions.

## Handoff

The original plan remains unchanged. Only this assessment was added, locally and uncommitted. No push, issue, credentials, deployment, service allocation or database action occurred; no cleanup is outstanding. The independent review completed. Evidence is document and source inspection; no application gate, browser run or live Otari call was performed.

Next action: correct R44, the R39 cycle oracle and the R30 overrun policy, then accept the concrete contract before starting Phase 1 in a new session. The remaining implementation proofs stay at their existing phase gates.
