# Write-confirmation spike (Phase 5)

> Run on 2026-11-15 for [phase-5.md](../plans/2026-11-15-retrofit-url-to-preview-phases/phase-5.md).
> Worktree `retrofit-worktrees/url-to-preview`, branch `feat/url-to-preview`, `HEAD` `69afc8554412972adeda10d409d6ea28dde23b83` at writing. Node v24.22.3, Playwright 1.65.1, headless Chromium.
> Specification commit: `git ls-remote https://github.com/cognizant-ai-labs/agentic-web HEAD` returned `63a956cf4653f610b1c238c70946f4d7647d17a8` on 2026-11-15, the same commit the plan pins. The local clone in `.local/vendor/agentic-web` is at that commit. The runtime's write handling is therefore unchanged from the plan's reading.
> Runtime under test: the vendored copy in `public/runtime/`, served by path and not modified.
> Evidence: `.local/spikes/` (ignored). Each scenario has a JSON record and, where a dialog was open, a screenshot; Playwright traces are in `.local/spikes/test-results/<test>/trace.zip`. The throwaway fixture source is archived in `.local/spikes/source/`; `spikes/` was deleted.

## Recommendation

Use option 1: register every state-changing action, including reversible cart changes, as `irreversible`, list them in `actions.agentTools`, and let the runtime's own confirmation run before each call. Retrofit's bundle replaces only the dialog's wording through `engine.onActionConfirm` and adds a guard against confirming a repeat of a call whose outcome is unknown. This is the only option that met spec §3.1 and §5 with the unchanged runtime while keeping the agent able to act in one turn. Option 3 (proposal path) also meets the spec but the agent stops after each action. Option 2 (`write` plus a handler dialog) does not meet §5 and has a timeout defect.

## Fixture

A synthetic bakery page on `http://localhost:3012` (one Node `http` process, pid 16192, listening on `127.0.0.1:3012` and `[::1]:3012`). `/runtime/*` was served read-only from `public/runtime/`. Each variant lived under `/<variant>/` with a generated `agent-manifest.json`, a one-agent network with `cruse` on, and one action module. The model was the scripted router from `e2e/support/mock-router.ts`, intercepted in the browser at `https://api.otari.ai/api/v1`; no request left the machine. The visitor's chat went through the runtime UI (`#ns-input`, `#ns-send`).

Actions: `get_shop_state` (read), `add_to_cart`, `set_cart`, `book_table`, `place_order`. `place_order` takes `expectedVersion`, the cart `items` and `totalCents` and refuses by return when any of them differs from the page, so the dialog shows what is bought (`references/site_actions.md:43-54`).

```js
reg("place_order", "Place the order for the cart. ...",
  { type: "object", additionalProperties: false, required: ["expectedVersion", "items", "totalCents"], properties: {
    expectedVersion: { type: "integer", minimum: 0, maximum: 100000 }, items: { type: "array", minItems: 1, maxItems: 10, items: line },
    totalCents: { type: "integer", minimum: 0, maximum: 1000000 } } },
  async (args, ctx) => {
    if (args.expectedVersion !== shop.version) return { ok: false, reason: `Cart changed (version ${shop.version}).` };
    if (JSON.stringify(args.items) !== JSON.stringify(shop.cart) || args.totalCents !== totalCents(shop.cart)) return { ok: false, reason: "Items or total differ from the cart." };
    shop.orders.push({ id: `ORD-${shop.orders.length + 1}`, items: args.items, totalCents: args.totalCents, requestId: ctx.requestId });
    shop.cart = []; bump();
    return { ok: true, order: shop.orders.at(-1) };
  });
```

## How the runtime confirms (code reading)

- `website_*` tools exist only for actions named in `manifest.actions.agentTools`, with availability `local-only`, on the top network; an `irreversible` one needs a confirmation callback (`public/runtime/runner.js:201-207`).
- On a call, the runner prepares a plan, then picks the confirm function: `ctx.confirmWebsiteActions` for `irreversible`, `async () => true` for anything else (`public/runtime/runner.js:347-359`). There is no flag or manifest field that changes this; `write` and `read` run without a dialog.
- `ActionRegistry.execute` passes a clone of the planned arguments to `confirm`, and after approval runs the handler with a clone of the same plan's arguments, a fixed `requestId` (`<invocationId>:<index>`) and an `AbortSignal`. A timeout aborts the signal and records status `unknown`; any throw is `unknown`; later steps are `not_started`; nothing is retried (`public/runtime/actions.js:130-153`).
- `confirmWebsiteActions` calls `engine.onActionConfirm` at call time (`public/runtime/engine.js:366`), which the UI sets to `reviewActions` (`public/runtime/ui.js:536`). The dialog text is `action — origin (effect)`, the description and the arguments as JSON (`public/runtime/action-transport.js:37-54`).
- Proposal path: an action the model proposes as a CRUSE button or form runs only after the visitor submits it, and always through `onActionConfirm`, whatever its effect (`public/runtime/engine.js:469-489`, `public/runtime/actions.js:132`). The engine keeps the validated proposal; the click carries only ids and form values. Receipts go into history as a user message, and no model call follows (`public/runtime/engine.js:482`).

## Option 1: every state-changing action is `irreversible`

Observed (VERIFIED, `.local/spikes/1a-irreversible.json`, `1a-add-dialog.png`, `1a-order-dialog.png`):

- The model's `website_add_to_cart` and `website_place_order` calls each opened the runtime dialog before the handler ran. The dialog showed the destination origin, the effect, the description and every argument: `place_order — http://localhost:3012 (irreversible)` then `{"expectedVersion": 1, "items": [{"item": "croissant", "qty": 2}], "totalCents": 700}`.
- Binding: a host `onActionConfirm` hook changed `qty` to 12 and `totalCents` to 1 in the items it received, after the visitor approved. The handlers ran with `qty: 2` and `totalCents: 700`. The model has no channel to change a pending call; the plan is fixed before the dialog opens.
- Receipts reached the model with `status: "succeeded"`, the action ref and the `requestId`; the order stored the same `requestId`.

Two calls in one reply and declines (VERIFIED, `1b-irreversible-parallel-decline.json`, `1b-book-dialog.png`): the two `add_to_cart` calls opened two dialogs in turn (website tools are `parallelSafe: false`, `runner.js:207`, `:250`). Approving the first and cancelling the second added only the first item; the second receipt was `{"status": "cancelled", "message": "Customer declined; nothing was submitted."}` (`runner.js:359`). A cancelled `book_table` stored nothing.

Unknown outcome (VERIFIED, `4a-timeout-unknown.json`, `4a-after-timeout.png`): `place_order` with `timeoutMs: 1500` stored the order, then never answered.

```js
shop.log.push({ action: "place_order", phase: "write-started", requestId: ctx.requestId, at: Date.now() });
shop.orders.push({ ... });
ctx.signal?.addEventListener("abort", () => shop.log.push({ ..., phase: "aborted-signal" }));
return new Promise(() => {});
```

After 1.5 s the model received `{"status": "unknown", "error": "Action timed out; outcome unknown. Check the site before retrying."}`. The runtime did not call the handler again: one `write-started` entry, one order, no further dialog in the next 3 s. The trace's tool span for this call ended with `status: "ok"`; only the receipt says `unknown`.

Model retry (VERIFIED, `4b-timeout-model-retry.json`, `4b-retry-dialog.png`): when the scripted model called `website_place_order` again with the same arguments, the runtime opened a new dialog identical to the first, with nothing saying the earlier attempt had an unknown outcome. Cancelling stored nothing more. INFERRED (not run; the test cancelled): had the visitor confirmed, the fixture would have stored a second order. The runtime itself does not repeat a write (spec §3.1), but it does not stop the model from asking again.

Costs: every cart change opens a dialog, and the default dialog labels a cart change "irreversible". The status line says "You confirm actions that cannot be undone before they run. Other actions run right away." (`public/runtime/index.js:74-77`), which stays true but is worded for orders. The hook receives no `requestId` (`actions.js:132`), so a custom dialog cannot show it; the id is fixed before the dialog opens and appears in the receipt.

## Option 2: `write` for cart changes plus Retrofit's confirmation in the handler

The handler opened its own dialog and refused by return without approval:

```js
async function guarded(name, args, ctx, change, honorSignal = true) {
  if (!await retrofitConfirm(name, args, ctx, honorSignal)) return { ok: false, reason: "The visitor did not approve this change. Nothing changed." };
  if (honorSignal && ctx.signal?.aborted) return { ok: false, reason: "Approval came after the action timed out. Nothing changed." };
  return change();
}
// retrofitConfirm shows Destination, Action, Request id and the arguments; when honorSignal is true
// it also closes on signal "abort" and resolves false.
```

Observed:

- A direct `website_add_to_cart` call opened only the Retrofit dialog (no runtime dialog). It showed destination, action, `requestId` and arguments. Decline left the cart unchanged; the model got `status: "succeeded"` with `result.ok: false` (VERIFIED, `2a-write-guard.json`, `2a-handler-dialog.png`).
- A bypass with an extra argument `confirmed: true` failed schema validation before any handler ran: `Error from tool 'website_add_to_cart': Unexpected arguments.confirmed.` (VERIFIED, `2a-write-guard.json`).
- A CRUSE button proposing the same write opened the runtime dialog, then the Retrofit dialog; both approvals were needed (VERIFIED, `2b-write-guard-proposal.json`).
- Defect: with the naive guard (dialog not tied to the abort signal) and `timeoutMs: 2000`, the runtime reported `unknown` to the model while the Retrofit dialog stayed open. Approving it afterwards changed the cart to 5 croissants after the model had been told the outcome was unknown (VERIFIED, `2c-write-guard-naive-timeout.json`, `2c-dialog-after-timeout.png`). The signal-aware guard closed its dialog at the timeout and changed nothing (VERIFIED, `2d-write-guard-signal-timeout.json`), but the visitor's approval time still counts against `timeoutMs`.

Spec fit: the model cannot bypass the guard in this fixture, but confirmation lives in site code inside the handler, not in the runtime, so spec §5 ("The runtime, not the model, owns confirmation", spec line 421) and §3.1 ("The runtime MUST ... show the user the destination and arguments", line 203-205) are met only by convention. The runtime records a declined change as `succeeded`, and every generated write handler must carry the guard correctly; one handler without it runs a write unseen. The skill lists this gap as a limit (`skills/agentify-website/SKILL.md:203-205`, `references/site_actions.md:110-114`).

## Option 3: a runtime setting that confirms `write`

No such setting exists in the vendored runtime: the confirm choice is hard-coded at `runner.js:356-357`. The only runtime-owned way to confirm a `write` is to leave the action out of `agentTools`, so it is offered only as a CRUSE proposal.

Observed (VERIFIED, `3-proposal.json`, `3-proposal-dialog.png`): the model's tools were `website_get_shop_state` and `render_cruse`; a direct `website_add_to_cart` call returned `Error: unknown tool 'website_add_to_cart'`. The proposed button opened the runtime dialog (`add_to_cart — http://localhost:3012 (write)` with arguments); after confirmation the cart changed and a receipt bubble appeared. The model request count stayed at 3 after the click: the agent does not continue until the visitor writes again, so "add these and place the order" takes several visitor turns. Every effect, including `read`, is confirmed on this path (`actions.js:132`).

## Cross-origin

A page on `http://127.0.0.1:3012` booting the network at `http://localhost:3012/irreversible` (another origin on the same process) booted, but the engine used `registerRemoteActions` (`engine.js:172-174`). The bridge exposed no action, because all were `local-only` (`action-transport.js:195`), the catalog was empty with the issue "No actions exposed to this caller", and the model got only `render_cruse` (VERIFIED, `5-cross-origin.json`). Executable action modules load only on their own origin (`action-transport.js:14`), and website tools exist only for `local-only` actions (`runner.js:203`). Bridge actions run only as visitor-submitted proposals, with a popup on the owning origin for any non-read action (`action-transport.js:158-170`, `:209-216`).

Consequence: each demo merchant must run its bundle on its own origin. A merchant calling another merchant's network gets that network's answers but none of its actions; bookings and orders stay on the owning site's page. The bridge is not needed for the demo; cross-site action transport is a spec extension (§3.1, line 205).

## Option comparison

| | Option 1: all `irreversible` | Option 2: `write` + handler dialog | Option 3: proposals only |
| --- | --- | --- | --- |
| Runtime shows destination and arguments before each write (§3.1) | Yes | No (site code does) | Yes |
| Confirmation bound to the executed call (§5) | Yes, plan fixed before dialog; hook mutation had no effect | Yes in handler closure, but not runtime-owned | Yes, engine keeps the validated proposal |
| Model bypass found | None | None in fixture; one unguarded handler would be one | None |
| Timeout after write start | `unknown`, not repeated by runtime | Naive dialog writes after `unknown` | INFERRED from code, not run: `unknown` (same `execute`) |
| Agent continues in the same turn | Yes | Yes | No |
| Dialogs per cart change | 1 | 1 (2 via a proposal) | 1 plus a click |

## Spec reasoning for option 1

- §3.1 "show the user the destination and arguments before a write or irreversible operation": the runtime dialog shows origin and every argument before the handler runs, for every state-changing action, because none is left as `write`.
- §5 "The runtime, not the model, owns confirmation. The executed action, origin, arguments, request identifier, and receipt are bound to the reviewed proposal": the runtime chooses to confirm, the hook only returns a boolean on a copy, and execution uses the planned arguments and the `requestId` fixed before the dialog (`actions.js:130-145`); the receipt carries action ref and `requestId`.
- §3.1 "Timeouts and disconnects after a write begins MUST be reported as having an unknown outcome ... the browser runtime MUST NOT independently repeat": observed in 4a; the repeat risk in 4b comes from the model, and each repeat still needs a new confirmation.
- §5 "Fail closed": a refused or invalid call returns an error or a refusal and runs nothing (2a extra-key case, `place_order` refusals).

## Risks

- Dialog fatigue: one dialog per cart change. Mitigation: prefer one `set_cart` call over several adds, and keep `read` actions dialog-free.
- Misleading words: the default dialog says "(irreversible)" for a cart change. A Retrofit `onActionConfirm` hook can show plain wording, but the status line at `index.js:76` is runtime text.
- Duplicate writes after an unknown outcome if the model asks again and the visitor confirms (4b). Grounding rules can forbid a retry, but the model may still ask. Three facts limit the mitigations (VERIFIED from code, not run):
  - The confirm hook receives only action, description, origin, effect and arguments, with no `requestId` and no receipt status (`actions.js:132`). A hook that refuses a repeat of an `unknown` call needs its own receipt record, for example from trace events or the receipts the runtime returns, and this was not built or tested in the spike (INFERRED design).
  - When the hook refuses, the runtime tells the model "Customer declined; nothing was submitted." (`runner.js:359`), which gives the model the wrong reason.
  - Each model call gets a fresh invocation id (`runner.js:358`), so `requestId` cannot serve as a site-side idempotency key across retries.
  The site must therefore make writes idempotent itself: `place_order` with `expectedVersion` that the handler bumps (the 4a/4b fixture handler did not bump it, so it could not catch the retry), and `book_table` with an idempotency token or version, which the fixture lacked. Duplicate bookings are the larger open risk.
- Observability: the trace marks an `unknown` receipt's tool span as `ok` (4a). Retrofit's UI and evidence must read receipt status, not span status.
- The hook gets no `requestId`, so the visitor cannot see it before confirming; it is visible in the receipt only.
- Steering while a dialog is open (the chat button becomes "Update") was not tested; the plan is fixed in code before the dialog (`runner.js:355-358`), so INFERRED that steering cannot change a pending call.
- The skill's own guidance keeps cart changes as `write` (`references/site_actions.md:116-120`); Retrofit's bundle will differ from the organizers' examples on purpose, and the bundle README must say why.
- The published action catalog labels reversible cart changes `irreversible`. Other agents that read `effect` will treat them as final, and Retrofit's own score of a site with the bundle should not count this as a defect. Not examined further in the spike (INFERRED impact).

## Work added to the second plan

1. Action generation: every state-changing action `irreversible` and listed in `agentTools`; reads stay `read`; refuse by return; `place_order`-style actions take items, total and `expectedVersion`.
2. Retrofit confirmation hook for the owner bundle: replaces `engine.onActionConfirm` with plain wording that still lists destination origin and every argument; one state-changing action per dialog. A repeat guard for `unknown` calls needs its own receipt record (the hook has no `requestId` or status), and its refusal reaches the model as "Customer declined", so the generated grounding rules must cover that wording.
2a. Site-side idempotency for every state-changing action: `expectedVersion` bumped by each write, and an idempotency token for bookings, so a confirmed repeat cannot create a second order or booking.
3. Grounding rules in generated networks for `cancelled`, `unknown` and `ok: false` results (the template's text).
4. Tests: browser cases equivalent to 1a, 1b, 4a and 4b (dialog content, binding, decline, unknown not repeated, retry guard) for each demo merchant, plus handler refusal tests.
5. Demo merchants on their own `demo-*` origins with the bundle installed there; no bridge actions.

## Evidence index (`.local/spikes/`)

| Scenario | JSON | Screenshot | Trace |
| --- | --- | --- | --- |
| 1a option 1 dialog and binding | `1a-irreversible.json` | `1a-add-dialog.png`, `1a-order-dialog.png` | `test-results/spike-1a-*/trace.zip` |
| 1b two calls, declines | `1b-irreversible-parallel-decline.json` | `1b-book-dialog.png` | `test-results/spike-1b-*/trace.zip` |
| 2a option 2 handler dialog, extra key | `2a-write-guard.json` | `2a-handler-dialog.png` | `test-results/spike-2a-*/trace.zip` |
| 2b option 2 via proposal | `2b-write-guard-proposal.json` | | `test-results/spike-2b-*/trace.zip` |
| 2c option 2 naive timeout | `2c-write-guard-naive-timeout.json` | `2c-dialog-after-timeout.png` | `test-results/spike-2c-*/trace.zip` |
| 2d option 2 signal-aware timeout | `2d-write-guard-signal-timeout.json` | | `test-results/spike-2d-*/trace.zip` |
| 3 option 3 proposals | `3-proposal.json` | `3-proposal-dialog.png` | `test-results/spike-3-*/trace.zip` |
| 4a unknown outcome | `4a-timeout-unknown.json` | `4a-after-timeout.png` | `test-results/spike-4a-*/trace.zip` |
| 4b model retry | `4b-timeout-model-retry.json` | `4b-retry-dialog.png` | `test-results/spike-4b-*/trace.zip` |
| 5 cross-origin | `5-cross-origin.json` | `5-cross-origin.png` | `test-results/spike-5-*/trace.zip` |

All ten scenarios ran in one Playwright run (10 passed, 20.6 s). The merchant server pid 16192 was recorded in `.local/spikes/merchant.pid` at start and stopped with `kill 16192`; port 3012 was free afterwards.
