# Phase 2: Journey 1 (address, reading, report, agent)

Part of [the Field Inspection UI plan](../2026-11-26-field-inspection-ui.md). Oracles: artboards `Main`, `A-Home-m`, `A-Scan`, `A-Scan-m`, `A-Report`, `A-Report-m` and the "Report page" and "Agent" rows of `A-States`.

## Entry conditions

- Phase 1 is accepted and merged locally into `develop`.

## Changes

### Unit A `[batch-eligible]`: home page

Files: `src/app/page.tsx`, `src/components/UrlForm.tsx`, new `src/lib/site/home-texts.ts`, new `src/components/home/ExampleSheet.tsx`, `e2e/landing.spec.ts`, `e2e/csp-fixture.spec.ts`.

- Sections in the canvas order: hero on the accent with the address form in a raised panel; stripe; "One address in. Three things out."; the inspection sheet with the example; "Ask Retrofit's own agent." on the ink with the existing `AgentPanel` (`page.tsx:33`); the work order with the existing lead link (`page.tsx:27`); footer.
- The `h1` becomes "Can an agent place an order on your site?". The lead sentence, the label "Your website address", the button name "Score my site", the RetrofitBot link text and the ids `site-url` and `site-url-error` stay (`UrlForm.tsx:49-79`). The JSON-LD block and the nonce stay (`page.tsx:13-19`).
- `ExampleSheet` takes its five rule texts from `CHECK_DEFINITIONS` by id (`aw.manifest`, `read.server-text`, `disc.robots-agents`, `data.jsonld`, `data.offers`) and is labelled "Example sheet". It is `aria-hidden` decoration with a text alternative in the section's paragraph.
- `e2e/landing.spec.ts:20` and `e2e/csp-fixture.spec.ts:36` read the old `h1` "Retrofit". They change to the new `h1` text from `home-texts.ts`. Titles stay (D9).

### Unit B `[batch-eligible]`: reading state and report

Files: `src/app/r/[id]/page.tsx`, `src/app/r/[id]/not-found.tsx`, `src/components/analysis/AnalysisView.tsx`, `ScoreReport.tsx`, `InstallPanel.tsx`, `SaveReportButton.tsx`, new `src/lib/score/group-points.ts`, new `src/components/analysis/scan-steps.ts`, `src/app/account/reports/[id]/page.tsx` (shell only).

```
@ groupPoints(checks) -> [{ group, earned, total, checked }]
ctx: none (pure)
pre: checks hold group, weight, result
do:
  1. compute total = sum of weights per group, in first-seen group order
  2. compute earned = sum of weights of "pass" checks per group
  3. compute checked = count of checks that are not "not-checked"
br: checked == 0 -> the bar is a dashed empty bar with the text "not checked"
risk: must not change or restate the score; the score stays report.score
```

```
@ scanSteps(status) -> [{ text, state }]   state: "done" | "now" | "next"
ctx: none (pure); texts are the existing STEP_TEXT values (AnalysisView.tsx:34-45)
do:
  1. lookup the position of status.step: queued 0, home/claim 1, probe* 2, page* 3, joined 3
  2. compute rows 0..3 from the position, and a last row "Scoring the 16 checks and building the agent"
  3. emit the current row's text from stepText(status), so "(page 4)" stays
br: unknown step -> position 1 with the text "Reading the site"
fail: none
```

- Reading state: the heading "Reading the site…", the current step line, a stripe bar whose width is the step position, the step list and the RetrofitBot note. The one `role="status"` region, the `analysis-progress` test id and the "The report is ready." line stay (`AnalysisView.tsx:51-67`).
- Report: section links (01 Score to 05 All checks); the score block with the stamp, `score-total` and `score-passed` (`ScoreReport.tsx:48-54`) and the group bars; "Fix these first" on the ink with `fix-first` and "(N points)" (D8); `children` (agent, install, save); "All checks" with rows as `<details>` (D7). Each row keeps `data-testid="check-<id>"`, the `<strong>` result word in lower case in the DOM (CSS makes it upper case), the rule and "(N points)" in the summary, and the evidence inside. A failed row adds "Fix: " with the `FIX_HINTS` text.
- Install panel: the download link as a primary button and the work order beside it. Texts, the `download` attribute and the `mailto` stay (`InstallPanel.tsx:10-27`).
- Failure notice (`AnalysisView.tsx:174-211`) and the not-found page use `Notice` with their existing texts and buttons.
- Phone bar: at 760 px and below, a fixed bar with "Try the agent" and "Get the files" that link to the two sections. It is not rendered while the report is not ready, and "Get the files" is absent when no bundle exists.

### Unit C `[batch-eligible]`: agent surface

Files: `src/components/preview/AgentPanel.tsx`, `Preview.tsx`, `src/components/key-panel/KeyPanel.tsx`.

- `AgentPanel`: a framed panel with the title, the free-AI status line and the key `<details>`. The banner (`free-banner`), the `#key-panel` anchor and `preview-label` stay (`AgentPanel.tsx:39-66`).
- `KeyPanel`: fields and buttons through the shared parts. No change to the form's logic, the uncontrolled key field or any attribute of it (`KeyPanel.tsx:150-239`). The visitor-key rule is untouched: this unit changes class names and wrappers only.
- `Preview`: the label, the boot alert and the notices list take the new look; `preview-mount`, `preview-notices` and `data-kind` stay (`Preview.tsx:173-196`). No change to the effects.

## Tests and oracles

- Unit: `tests/score/group-points.test.ts` (totals equal the weights in `checks.ts:13-30`; a group with only not-checked rows), `tests/analysis/scan-steps.test.ts` (each step value and an unknown one), `tests/site/home-texts.test.ts` ("Sixteen" equals `CHECK_DEFINITIONS.length`; the example ids exist).
- e2e, added to `e2e/field-inspection.spec.ts`: a failed row is open with evidence and a fix; a passed row opens with the keyboard; the section links move focus to their sections; at 390 px the phone bar is visible, the last footer link can be clicked and a focused control is clear of the bar; at 1440 px the bar is not rendered; the boot-error alert has at least 4.5:1; size and overflow checks for `/` and a report at 390, 768, 1024 and 1440 px.
- Existing, unchanged: `e2e/analyze.spec.ts`, `key-panel.spec.ts`, `free-path.spec.ts`, `preview.spec.ts`, `hostile-output.spec.ts`, `spec6*.spec.ts`, `redirects.spec.ts`, and the contrast and 320 px tests.

## Exit criteria

- Full gate passes on the committed candidate; the analyzer reports ACCEPTED; `git diff develop -- src/lib/keys src/lib/preview public/runtime` is empty.
- Screenshots of `/`, the reading state, a report, a failed analysis and the not-found page at 1440 and 390 px are in `.local/design/field-inspection/app-shots/phase-2/`.
- Stop for Juan's acceptance.
