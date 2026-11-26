# Phase 4: Remaining pages and close

Part of [the Field Inspection UI plan](../2026-11-26-field-inspection-ui.md). Oracles: artboards `A-Pricing`, `A-Pricing-m`, `A-Judges`, `A-Docs`, the "Email · unsubscribe" row of `A-States` and the badge preview on `A-Account`.

## Entry conditions

- Phases 2 and 3 are accepted and merged locally into `develop`.

## Changes

### Unit A `[batch-eligible]`: pricing

Files: `src/app/pricing/page.tsx`, `src/components/NotifyForm.tsx`.

- Title block; the free notice as a `Notice` with a stripe (`pricing/page.tsx:36-40`); three plan sheets tagged "Plan 01" to "Plan 03" from the index in `PLANS`, with the Pro sheet on the ink. Plan names stay `h2` (`e2e/pricing.spec.ts:8`). Amounts (`price-<id>`), the unavailable text and the upgrade button keep their rules (`pricing/page.tsx:49-67`).
- A sheet without an amount shows nothing in the price line. The canvas texts "No charge" and "Price not set yet" are not added: the page already says when prices are not set (`PRICING_TEXT.pricesNotSet`).
- The notify form in a raised panel on the accent. Label, checkbox, privacy link and ids stay (`NotifyForm.tsx:40-75`).

### Unit B `[batch-eligible]`: judges

Files: `src/app/judges/page.tsx`, `src/components/JudgeForm.tsx`.

- Two columns: the mono label "Open Agentic Web Challenge", the `h1` "Judges" and the two paragraphs; the code form in a panel with a stripe. Under 760 px they stack.
- The field stays `type="password"` with `autoComplete="off"`; the status region keeps its id (`JudgeForm.tsx:46-70`).

### Unit C `[batch-eligible]`: text pages

Files: `src/app/bot/page.tsx`, `src/components/LegalPage.tsx`, `src/app/unsubscribe/page.tsx`, `src/app/conformance/page.tsx`.

- Text pages get a title block and numbered sections ("01", "02", …) from the order of their `h2` elements, with body text at a readable measure (at most 70 characters per line).
- `/bot`: the robots lines in a code block on the ink with an accent bar; "For agents" keeps `id="score-api"` (`bot/page.tsx:34`).
- `/privacy` and `/terms`: `LegalPage` renders the same document data (`LegalPage.tsx:7-19`); no text changes.
- `/unsubscribe`: the confirm state and each outcome as a `Notice`; roles stay (`unsubscribe/page.tsx:19-31`).
- `/conformance`: the fixture list (`conformance-fixtures`) as a table-like sheet and the agent panel from Phase 2.

### Unit D `[batch-eligible]`: badge and icon

Files: `src/lib/badge/svg.ts`, `tests/badge/badge.test.ts`, new `src/app/icon.svg`.

```
@ badgeSvg(score) -> svg text
ctx: none (pure); input is a number or null and nothing else reaches the image
pre: the line text stays badgeLine(score) for <title> and aria-label
do:
  1. validate the score as now (integer 0 to 100, else no number)
  2. compute a 44 px high badge: an accent block with the score in ink, an ink block with two lines in paper
  3. write "AGENT-READY" and "VERIFIED BY RETROFIT" as SVG text in the system font stack
  4. emit fixed colours #0E0E0E, #26EFE9 and #F0F1F0
br: no valid score -> the accent block shows a check mark shape and the first line reads "AGENT-READY CHECK"
risk: an <img> cannot load web fonts, so text widths use textLength as now
```

- The response headers and the 404 and 503 rules do not change (`src/lib/badge/handler.ts:16-34`).
- `icon.svg`: an ink square with an accent "R" shape drawn as a path, no text element.

### 5. Close (sequential, after the units are merged)

- Remove the `--color-*` and `--radius` aliases from `globals.css` and any last use in `src`.
- Add a decision record `docs/decisions/2026-11-26-field-inspection-ui.md`: D0 to D9 with their evidence, and that it replaces the key panel's "neutral style for now" (`docs/decisions/2026-11-15-open-source-and-key-panel-style.md`, "Key panel style").
- Add the two font packages to `NOTICE` with their licence. Add a `CHANGELOG.md` entry.
- Update `.rpi/release-profile.json` `current_gaps`: the UI review part closes when Juan accepts the visual review.
- Write the implementation notes file `docs/plans/2026-11-26-field-inspection-ui-notes.md` with results, deviations and the evidence identities.

## Tests and oracles

- `tests/badge/badge.test.ts`: updated for the new geometry; it keeps the tests that no input but the score reaches the image, that an invalid score shows no number, and the header tests.
- `tests/site/design-tokens.test.ts`, last part: no `--color-` and no `--radius` name remains in `src`.
- e2e, added to `e2e/field-inspection.spec.ts`: size and overflow checks for `/pricing`, `/judges`, `/bot`, `/privacy`, `/terms`, `/unsubscribe` (both states) and `/conformance` at 390, 768, 1024 and 1440 px; the icon answers 200 with `image/svg+xml`.
- Existing, unchanged: `e2e/pricing.spec.ts`, `judges.spec.ts`, `privacy.spec.ts`, `conformance.spec.ts`, `billing.spec.ts`, and the contrast and 320 px tests.

## Exit criteria

- Full gate passes on the committed candidate; the analyzer reports ACCEPTED; `pnpm vendor:verify` passes; `git diff <plan base> -- tools/release/required-tests.json` is empty.
- Screenshots of every route and state named in the plan at 1440 and 390 px are in `.local/design/field-inspection/app-shots/final/`, in the artboard order of the canvas.
- Juan's visual review (plan criteria 7 and 8) is recorded in the notes file.
- Stop. Push, deploy and release are separate authorizations; before an integration push run `bash /Users/juan/code/archy/scripts/strix-scan.sh /Users/juan/code/retrofit`.
