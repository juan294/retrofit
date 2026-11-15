# Phase 5: Write-confirmation spike (time-boxed, 1 day)

Parent plan: [2026-11-15-retrofit-url-to-preview.md](../2026-11-15-retrofit-url-to-preview.md).

## Goal

Reduce the main risk of the second plan before more time is spent: show how an installed Retrofit bundle can let the agent change a cart and place a booking on the owner's own site, with the visitor shown the destination and arguments before every write, using the unchanged vendored runtime. The output is a decision record, not product code.

## Background

- Spec §3.1: the runtime "MUST validate arguments and show the user the destination and arguments before a write or irreversible operation". Spec §5: "The runtime, not the model, owns confirmation."
- The skill notes that the runtime runs `write` actions without showing the visitor first (`SKILL.md:203-205`), while `irreversible` actions go through `confirmWebsiteActions` (`references/site_actions.md:112-114`, agent report).

## Entry conditions

- Phase 4 accepted.
- Re-read `cognizant-ai-labs/agentic-web` and record the commit. If the runtime changed its write handling, start from the new behavior.
- Time box: one working day. Stop when the box ends, with whatever evidence exists.

## Work

- Build a throwaway synthetic merchant fixture in `spikes/write-confirmation/` (bakery with a cart and a booking form), served on `http://localhost:3012`, with the vendored runtime and a manifest that registers `add_to_cart`, `set_cart`, `book_table` and `place_order` actions.
- Try, in this order, and record the observed behavior for each:
  1. Classify every state-changing action as `irreversible`, so that the runtime's own confirmation applies. Check what the dialog shows (destination, arguments) and whether it is bound to the executed call.
  2. Keep `write` for reversible cart changes and add Retrofit's own confirmation inside the action handler (the handler shows a dialog and refuses without approval). Check that the model cannot bypass it.
  3. Check the runtime for any setting that confirms `write` actions.
- For the chosen option, check unknown-outcome handling: a handler that times out after the write starts must be reported as an unknown outcome and must not be repeated (spec §3.1).
- Check the cross-origin case only far enough to say whether the second plan's demo merchants need the bridge (`runtime/action-transport.js`) or can run the bundle on their own origin.

## Output

- `docs/research/write-confirmation-spike.md` with the run date in its header: the runtime commit, each option's observed behavior with screenshots or Playwright traces kept in ignored `.local/spikes/`, the recommended option and its spec reasoning, risks, and the work it adds to the second plan.
- The spike code stays in `spikes/` only if the owner wants it kept; otherwise it is deleted before the phase ends. It never enters the gate.

## Acceptance

- The research document exists and names one recommended option with evidence, or states that no option meets the spec with the unchanged runtime and what that means for the second plan.
- No product code changed. The gate still passes.

## Resources

- The merchant fixture server is a task-owned process on port 3012. Record its pid before start and stop it at the end of the spike. Report it.

## Exit

Stop for owner acceptance. The owner decides the write-confirmation approach for the second plan from the document.
