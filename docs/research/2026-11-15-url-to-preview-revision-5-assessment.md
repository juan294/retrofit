# URL-to-preview revision 5: acceptance review

Reviewed 2026-11-15 at `6da5901492f8afcdc3c45dd3750922da9685fef6`, branch `develop`, `/Users/juan/code/retrofit`, clean at entry. **Accepted at plan-review level: no remaining blocking planning finding detected.** This is acceptance of the proposed implementation contract, not evidence that its behavior works or authorization to publish.

## Scope and evidence

Applied `rpi-assess`, with no project overlay or override. Reviewed the delta from `09fe0167cf53b3dd3ff2d91293a7d6ef4a68423e`, the complete revised Phase 6, and the changed Phase 4 and Phase 7 contracts, reusing prior reads of unchanged plan text and controlling instructions. This narrow follow-up stayed with the parent reviewer; no new independent subagent review was commissioned.

The question is whether the three corrections and two adapter details from the revision 4 assessment are sufficiently specified to begin phased implementation. Criteria are runtime compatibility, consent containment, truthful conformance evidence, persistent spending controls and explicit acceptance of unresolved provider risk. Upstream references below are under `skills/agentify-website/` in `cognizant-ai-labs/agentic-web` at pinned commit `63a956cf4653f610b1c238c70946f4d7647d17a8`. Evidence is local document and pinned-source inspection, not a fresh upstream-version survey.

## Dispositions

| Finding | Disposition and evidence |
| --- | --- |
| R44: tool-result schema | Resolved at plan level. Phase 6:68-69 accepts the runtime's `name` field, validates it and replays captured runtime bodies. Phase 4:125 binds captures to the vendor manifest; Phase 6:137 requires a complete free-path tool round-trip. This matches `runtime/runner.js:585` and unchanged message forwarding at `runtime/llm.js:85-92`. |
| R39 follow-up: cycle oracle | Resolved at plan level. Phase 4:124 requires suppression of the back-edge tool, no recursive network fetch, the expected trace event and a visible notice. Phase 7:127 carries the production prevention case and rejects unknown-tool errors as evidence. This matches `runtime/runner.js:168-174`. The adapter can observe the event: `runtime/trace.js:10` extends `EventTarget`, `:23` dispatches the event and `:59-60` emits notes. |
| R30 follow-up: overrun policy | Resolved at plan level. Phase 6:56-60 includes outstanding reservations, remaining-credit judge availability and a non-expiring hold with authorized reconciliation. Phase 6:132 requires rollover and restart tests. The parent plan:87-90 explicitly qualifies the billing assumptions and defers acceptance of the guarantee level to Phase 6. |
| A1: consent origin mapping | Resolved at plan level. Phase 4:67 requires exactly one configured full-origin match for the runtime's host-and-port value, otherwise no approval. Phase 4:111 tests ambiguity and port distinctions. This matches `runtime/runner.js:33-34,428`. |
| A2: router probe | Resolved at plan level. Phase 4:53 permits the origin-root manifest probe, matching `runtime/engine.js:41-44`; Phase 4:112 requires the recorder test to use that path. |

The selected approach preserves the pinned runtime and puts compatibility checks and presentation in Retrofit's adapter. It is preferable to another runtime fork or an artificial cycle-error fixture: the proposed tests now exercise the actual integration behavior. The persistent hold is preferable to automatic midnight reopening because an observed overrun invalidates the assumed bound. Provider-enforced caps remain preferable to a ledger-only guarantee when their actual semantics support the required isolation.

## Remaining review points

One non-blocking wording inconsistency remains: Phase 6:7 still says "a provable upper bound," while the parent plan:87 correctly calls it a conservative bound dependent on provider assumptions. Align that sentence with the parent during the next documentation update. This acceptance uses the explicitly qualified guarantee; it does not accept an unconditional proof of billing safety.

The planned phase gates remain necessary. In particular:

- Phase 1 must demonstrate the Next.js nonce and CSP behavior in the actual build.
- Phase 3 requires owner acceptance of the score weights; Phase 5 requires acceptance of the write-confirmation approach.
- Phase 6 must establish Otari's actual protocol, billing and spending-limit semantics and obtain written acceptance of the reserve guarantee. The mere existence of a setting labelled a key limit is insufficient to establish its reset period, enforcement behavior or isolation. A public judge code also remains an availability risk if Devpost has no private field.
- Phase 7 must produce candidate-bound production conformance evidence and analyzer acceptance before final release acceptance and tagging.

The 24-working-day schedule remains an estimate with limited holiday slack. Plan acceptance is not evidence that the second plan will fit. A failed phase gate or a provider result inconsistent with these assumptions requires a concrete adjustment before dependent work.

## Handoff

Only this assessment was added, locally and uncommitted. The plan and application/configuration files were not changed. No implementation, application gate, browser test or live provider probe was performed. Whitespace validation covers the revision delta and this assessment only; it is not application verification. No push, issue, credential, deployment, service allocation or database action occurred, and no cleanup is outstanding.

Next action: Phase 1 in a new implementation session, after the owner's start instruction, using the approved plan and its normal acceptance boundary. Revalidate the checkout and candidate identity at entry. This review does not start Phase 1 or grant external-action authority.
