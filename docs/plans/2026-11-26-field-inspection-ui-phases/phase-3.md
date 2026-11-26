# Phase 3: Journey 2 (sign in, claim, publish, public page)

Part of [the Field Inspection UI plan](../2026-11-26-field-inspection-ui.md). Oracles: artboards `A-SignIn`, `A-SignIn-m`, `A-Account`, `A-Account-m`, `A-Published`, `A-Published-m` and the "Sign in", "Account" and "Published page" rows of `A-States`.

## Entry conditions

- Phase 1 is accepted. Phase 2 is not required, except that `ScoreReport` from Phase 2 must be merged before Unit C is reviewed against the canvas.

## Changes

### Unit A `[batch-eligible]`: sign-in

Files: `src/app/sign-in/page.tsx`, `src/components/SignInForm.tsx`, `src/app/auth/confirm/page.tsx`, `src/components/ConfirmSignInForm.tsx`.

- Two-column layout: step label, title and intro on the left; the form panel on the right. Under 760 px they stack.
- Step label: "Step 1 of 3 · Your address" on `/sign-in`, "Step 2 of 3 · The link" after the form's sent answer, "Step 3 of 3 · Confirm" on `/auth/confirm`. The label is a mono label, not a heading. The `h1` texts stay from `SIGN_IN_TEXT` (`sign-in/page.tsx:21`, `auth/confirm/page.tsx:35`).
- The deleted, unavailable, busy and expired states (`sign-in/page.tsx:22-37`) and the address step with its warning (`ConfirmSignInForm.tsx:35-54`) use `Notice`. Roles, test ids (`confirm-address`, `other-browser`) and the hidden form fields stay.
- "Cancel" stays a second form with a quiet button (`ConfirmSignInForm.tsx:49-52`).

### Unit B `[batch-eligible]`: account

Files: `src/app/account/page.tsx`, `src/components/claims/ClaimsSection.tsx`, `src/components/publish/PublishControls.tsx`, `src/components/billing/ApiKeysSection.tsx`, `BillingSection.tsx`, `BillingButton.tsx`, `src/components/ConfirmButton.tsx`, new `src/components/claims/claim-stage.ts`.

```
@ claimStage(view) -> { label, tone }
ctx: none (pure); view is AccountClaimView (status: pending | verified | lapsed | superseded; site or null)
do:
  1. lookup status and site
  2. compute the label and tone
br: pending -> "Step 1 · Prove it", info
br: verified and no site -> "Step 2 · Publish it", info
br: verified and site -> "Step 3 · Live", accent
br: lapsed or superseded -> "Needs attention", action
risk: the label is decoration; claim-status keeps the real status text
```

- Numbered sections "01 · Your plan" to "05 · Delete your account" as mono labels above the existing `h2` texts. The plan section appears only when billing has started, as now (`account/page.tsx:97`); the numbers then run from the first section that is shown.
- Saved reports: a list with the score in a block, the host link and the date (`account/page.tsx:108-120`).
- Claims: the new-claim form in a panel; each claim as a sheet with the stage header from `claimStage`. Every test id (`claim`, `claim-status`, `claim-token`, `claim-reason`, `claim-message`, `second-step`, `publish`, `publish-link`, `publish-saved`, `publish-error`, `publish-paused`, `badge-snippet`), every `aria-label` from `T.buttonName` and the focus targets stay (`ClaimsSection.tsx:147-204`, `PublishControls.tsx:19-58`, `ConfirmButton.tsx:36-57`).
- Badge preview: beside the snippet, the real image `<img src="/badge/<host>.svg">` with the snippet's alt text. The policy allows it (`img-src 'self'`, `headers.ts:42`).
- API keys: the new key in a notice with a code block (`api-key`), the list rows with Revoke through `ConfirmButton`.
- Delete: a panel with a stripe at the top, the checkbox and the button. The form stays a plain POST with `required` (`account/page.tsx:129-137`).
- The second step of `ConfirmButton` is a `Notice` of tone "action" inside the same `role="group"`.

### Unit C `[batch-eligible]`: published page

Files: `src/app/s/[host]/page.tsx`, `error.tsx`, `not-found.tsx`, `src/components/publish/PublishedAgent.tsx`.

- Header block: "Agent readiness of", the host as the `h1` text from `T.title(site.host)`, the published-by line (`published-by`) and the score block.
- Agent: the heading from `T.agentTitle(host)`, the own-key note, the key panel and, before a key connects, an empty frame with "The agent starts here". After a key connects, the runtime mounts as now (`PublishedAgent.tsx:29-34`). A long host breaks only at a dot (`<wbr>` before each dot), never inside a label.
- Closing block: "Is your site ready for agents?" with a "Score my site" link to `/`. The texts go in `src/lib/site/home-texts.ts` (created in Phase 2; if Phase 2 is not merged yet, this unit creates the file with these two strings and Phase 2 adds its own).
- `error.tsx` and `not-found.tsx` use `Notice` with their existing texts and buttons.

## Tests and oracles

- Unit: `tests/claims/claim-stage.test.ts` (the four branches).
- Existing unit tests that read markup pass without change: `tests/accounts/pages.test.ts`, `tests/accounts/confirm.test.ts`, `tests/claims/page.test.ts`, `tests/publish/panel.test.ts`, `tests/billing/api-keys-section.test.ts`.
- e2e, added to `e2e/field-inspection.spec.ts`: the step label on each of the three sign-in screens; the stage label for a pending, a verified, a published and a lapsed claim (using `claimStates` and `publishStates` from `e2e/support`); the badge preview image loads with status 200; size and overflow checks for `/sign-in`, `/auth/confirm`, `/account` and a published page at 390, 768, 1024 and 1440 px.
- Existing, unchanged: `e2e/account.spec.ts`, `claims.spec.ts`, `publish.spec.ts`, `billing.spec.ts`, and the contrast and 320 px tests for the claim, publish and billing states.

## Exit criteria

- Full gate passes on the committed candidate, including `test:db`; the analyzer reports ACCEPTED.
- Screenshots of the three sign-in screens, the address step, `/account` with one claim in each stage, a published page, its not-found page and its outage page at 1440 and 390 px are in `.local/design/field-inspection/app-shots/phase-3/`.
- Stop for Juan's acceptance.
