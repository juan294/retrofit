# Plan: Field Inspection UI for every Retrofit page

> Created 2026-11-26 with `rpi-plan` on `develop` `474e366`. Not approved for implementation yet. Phase files: [phase-1](2026-11-26-field-inspection-ui-phases/phase-1.md), [phase-2](2026-11-26-field-inspection-ui-phases/phase-2.md), [phase-3](2026-11-26-field-inspection-ui-phases/phase-3.md), [phase-4](2026-11-26-field-inspection-ui-phases/phase-4.md). No project overlay exists (`.rpi/project/rpi-plan.md` is absent), so no declared override applies.

## Objective

Every page, screen and state of Retrofit uses the "A · Field Inspection" design that Juan chose on 2026-11-26, with the orange accent replaced by a brand colour of the hackathon sponsor. The change is presentational: no route, API, text key, data rule or security rule changes. This closes the "UI review" gap of v0.3.0 in `.rpi/release-profile.json` (`current_gaps`).

## The design oracle

- Canvas (private to Juan): https://claude.ai/artifact/Y5JXkJJP7cWDjWXNr6jVmo, version 40, 17 artboards, already in the new colour.
- Local copy, ignored by Git and durable on this machine: `/Users/juan/code/retrofit/.local/design/field-inspection/`. `mockups/` holds the 17 `.dc.html` sources (exact CSS values), `shots/` holds a full-page PNG of each artboard at its board width (1440 or 390 px), and `tools/check.cjs` renders the mockups again. A worktree reads this folder by its absolute path.
- Where the canvas and this plan differ, this plan wins. The differences are listed in "Canvas items that change or stay out".

## Scope

In scope:

1. A design foundation: tokens, self-hosted fonts, shared interface parts, the page shell (header, footer), one notice pattern and the theme of the vendored runtime's panel.
2. Every route under `src/app/` that renders a page, and every component under `src/components/`.
3. The badge image (`src/lib/badge/svg.ts`) and a site icon.
4. Tests for the new behaviour, and the updates that existing tests need.

Out of scope:

- The vendored runtime, `public/preview-assets/` and `tools/agentic-web/` (never edited). The chat inside the agent panel stays the runtime's own interface and gets colours and fonts only through its CSS variables.
- The downloaded bundle's `/assistant/` page (`src/lib/bundle/`), the Harbor tours demo site (`peers/`), email messages, the Stripe pages and an Open Graph image.
- Any text in `src/lib/site/*-texts.ts`, `src/lib/analysis/texts.ts` and `src/lib/site/legal-texts.ts`. New text goes in new modules.
- A dark theme, a verdict sentence on the report and a custom agent network diagram (see the decisions).
- Push, deploy and release. Each needs Juan's authorization for that exact action.

## Decisions

Juan decided D0. I decided D1 to D9 from the evidence below; each is one token or one component to change if Juan wants another answer.

| ID | Decision | Reason and evidence |
| --- | --- | --- |
| D0 | Field Inspection is the design. Orange is replaced by a dominant colour of the main sponsor. | Juan, 2026-11-26. |
| D1 | Accent `#26EFE9` (Cognizant bright teal). Link hover `#2E308E` (Cognizant indigo). Ink `#0E0E0E` and paper `#F0F1F0` stay. | VERIFIED: the rules page names "Sponsor and Administrator: Cognizant Technology Solutions Corporation". VERIFIED in `https://www.cognizant.com/styles/styles.css` on 2026-11-26: `--primary: #000048`, `--accent3-medium: #26efe9`, `--accent2-dark: #2f78c4`, `--accent1-dark: #2e308e`. The primary `#000048` has a contrast of 1.01:1 with the ink, so it cannot be an accent beside black. Ink on `#26EFE9` is 13.43:1 (orange was 5.74:1). Blue `#2F78C4` gives 4.23:1 under ink text and fails 4.5:1. |
| D2 | One fixed light theme. The page looks the same when the system is in dark mode. | The canvas has no dark design. The release-required contrast tests run in both schemes (`e2e/preview-theme.spec.ts:57`) and keep their titles; they then prove that dark mode changes nothing. |
| D3 | Fonts come from `@fontsource-variable/archivo` and `@fontsource/ibm-plex-mono` through `next/font/local`. | The page policy has `font-src 'self'` (`src/lib/security/headers.ts:43`), so Google's font host is not possible. VERIFIED on 2026-11-26: both packages are version 5.3.0 and OFL-1.1; `files/archivo-latin-wdth-normal.woff2` is 90,104 bytes; the mono weights 400, 500 and 600 are about 15 KB each. INFERRED: the `wdth` file also carries the weight axis; Phase 1 has a test for it. `declarations` in `next/font/local` sets the stretch range (`node_modules/next/dist/docs/01-app/03-api-reference/02-components/font.md:236`). |
| D4 | Styles are tokens plus component classes in `src/app/globals.css`, used through shared parts in `src/components/ui/`. No colour value and no inline colour style in a component. | Today 30 component and page files hold 115 `var(--color-…)` uses, most of them in inline styles (`grep -ro "var(--color-[a-z-]*\|var(--radius" src`). The policy allows inline styles (`headers.ts:41`), so this is a maintenance choice. A unit test enforces it. |
| D5 | The runtime panel is themed with its own variables on `.runtime-surface`: `--ns-font`, `--ns-fg`, `--ns-bg`, `--ns-border`, `--ns-muted`, `--ns-panelbg`, `--ns-accent`, and `--ns-primary` set to the ink, not to the accent. | VERIFIED in `public/runtime/ui.js:131-138`: the runtime reads these variables. Its primary buttons have `color:#fff` built in (`ui.js:179`, `:187`, `:204`); white on the accent is 1.44:1. The existing wrapper rules already style the runtime from outside (`src/app/globals.css:51-57`). |
| D6 | The DOM contract stays: every `id`, `data-testid`, label, button name, link text and target, heading text (except the home page `h1`), and every `role="status"` and `role="alert"` region. | 175 Playwright tests and many unit tests are release evidence (`tools/release/required-tests.json`, read by `tools/release/analyze-evidence.mjs:445`). Production probes use `#site-url-error` (`e2e-prod/probes.spec.ts:20`). Unit tests read markup, for example the navigation's three plain links in order (`tests/site/site-nav.test.ts:10`, `:16-19`). |
| D7 | Check rows are `<details>`. A failed row starts open; other rows start closed. The summary line keeps the result word in `<strong>`, the rule and "(N points)". | Existing tests read these from the row and must pass without change (`e2e/analyze.spec.ts:16-18`, `e2e/preview-theme.spec.ts:263`). |
| D8 | Points keep the product's words: "(15 points)", not the canvas's "+15 pts". | A release-required test reads this text (`e2e/analyze.spec.ts:33`). Plain words also fit the writing standard. |
| D9 | Existing required tests keep their file and title. Only assertions that name the old home `h1` change. | The analyzer matches tests by file and title. |

Computed contrast (WCAG formula, this session): ink on paper 17.05, ink on white 19.30, ink on accent 13.43, accent on ink 13.43, `#D7D8D6` on ink 13.50, indigo on paper 9.61, accent on paper 1.27, accent on white 1.44. Rule that follows: the accent is a fill under ink text, or text on the ink. It is never text on paper or white, and never the only edge of a control.

## Canvas items that change or stay out

| Canvas item | In the product | Plan |
| --- | --- | --- |
| Verdict sentence under "9 of 14 checks passed." | No such data; `report.summary` is a count (`src/lib/score/score.ts:54`). | Out. The block shows the count and the group bars. |
| Points per group with a bar | Derivable from `checks` (`src/lib/score/checks.ts:13-30`). | In, as a pure function (Phase 2). |
| "+15 pts" | "(15 points)" | D8. |
| Custom chat bubbles, consent card and "The agent network" list | The vendored runtime renders its chat and its agents slot (`src/components/preview/Preview.tsx:110-120`). | Out. Theme only (D5). |
| Two-line badge, 44 px | One line, 24 px (`src/lib/badge/svg.ts:11-22`). | In (Phase 4). The words stay "Agent-ready N/100 · verified by Retrofit". Publishing is not released (`AGENTS.md`, "Current state and authority"), so no site embeds the old badge. |
| Example sheet on the home page | New. | In. The five rule texts come from `CHECK_DEFINITIONS`; the sheet is labelled "Example sheet". |
| Home copy: headline, three steps, section headings | New. | In, in `src/lib/site/home-texts.ts`, with the wording of the canvas. "Sixteen" is tested against `CHECK_DEFINITIONS.length`. |
| "Form R-01 · Agent readiness inspection" labels | New, decorative. | In, one per page shell. |
| "Step 1 of 3" on sign-in; "Step 1 · Prove it" on claims | Derivable from the page state and the claim status. | In (Phase 3). |
| Report section links and the phone bar "Try the agent / Get the files" | New. | In (Phase 2). |
| "Is your site ready for agents?" on a published page | New. | In (Phase 3). |
| Phone frames for Judges, text pages and states | Not drawn. | The same container rules apply; the 320 px tests cover them. |

## Current state (verified 2026-11-26 on `develop` `474e366`)

- Stack: Next.js 16.4.6, React 19.3.1, Tailwind 4.3.5 through `@tailwindcss/postcss` (`package.json`, `postcss.config.mjs`). Read `node_modules/next/dist/docs/` before writing code (`AGENTS.md`).
- Tokens: nine colours and a radius in `:root`, with a dark set (`src/app/globals.css:3-29`). In dark mode the runtime panel gets a light surface (`globals.css:40-48`).
- Shell: `SiteNav` is a `<nav>` with three plain links (`src/components/SiteNav.tsx:8-18`). `SitePage` is a 672 px column for text pages (`src/components/SitePage.tsx:7`). Seven pages build their own `<main>` (`grep -rlw SiteNav src`). The footer exists only on the home page (`src/app/page.tsx:34-50`).
- The same button and field styles are repeated inline in about 20 files, for example `src/components/UrlForm.tsx:60-68` and `src/components/JudgeForm.tsx:56-64`.
- The report is one component for the live report, a saved report and a published page (`src/components/analysis/ScoreReport.tsx:38-104`). The reading state shows two lines of text (`src/components/analysis/AnalysisView.tsx:51-67`).
- Status and error texts go through `StatusMessage` (`src/components/StatusMessage.tsx:26-33`) or local `role="alert"` paragraphs.
- Oracles that exist: contrast of at least 4.5:1 for the texts of every page and state in light and dark (`e2e/preview-theme.spec.ts`), and no sideways scroll at 320 px for the same set (`e2e/phone-width.spec.ts:11-14`). Every e2e test fails on a policy violation (`e2e/fixtures/csp`).
- `src/**/*.ts` and `*.tsx` hold no hex colour outside `src/lib/badge/svg.ts` (`grep -rn "#[0-9a-fA-F]\{6\}\b" src --include='*.tsx' --include='*.ts'`).

## Design specification

Values are from the canvas sources and are the contract for Phase 1.

- Colour tokens: `--fi-paper #F0F1F0`, `--fi-ink #0E0E0E`, `--fi-accent #26EFE9`, `--fi-white #FFFFFF`, `--fi-on-ink-muted #D7D8D6`, `--fi-link-hover #2E308E`. No other colour.
- Type: display is Archivo at `font-stretch: 62%`, weight 900, uppercase, line height 0.8 to 0.9. Body is Archivo at normal width, 18 px, line height 1.45, weights 400 and 600. Labels and code are IBM Plex Mono, 13 px, weight 500, letter spacing 0.08em, uppercase for labels.
- Fluid sizes use the page as a container: `container: page / inline-size` on the shell, `clamp()` with `cqw` units, and one breakpoint, `@container page (max-width: 760px)`. Home headline: `clamp(52px, 13.2cqw, 200px)`. Page padding: `clamp(20px, 4cqw, 56px)`.
- Surfaces: borders 3 px ink, radius 0, hard shadow `8px 8px 0` ink on raised panels. Interactive raised parts move by `-3px, -3px` on hover with a `9px 9px 0` shadow, 0.12 s.
- Marks: hazard stripe `repeating-linear-gradient(-45deg, ink 0 12px, accent 12px 24px)`, 12 to 16 px high. Stamp: a round mark rotated by -8 degrees with a 0.5 s entry.
- Controls: at least 44 px high. The hero field and button are 68 px. Primary button: ink fill, paper text. Accent button: accent fill, ink text, ink border. Focus: `outline: 4px solid` ink with a 3 px offset; on the ink the outline is paper.
- Motion stops under `prefers-reduced-motion: reduce`.
- Wrap rule (found in the canvas render check): the shell has `overflow-wrap: anywhere`, so display headings set `overflow-wrap: break-word`, heading flex items use `flex: 0 1 auto`, and buttons use `white-space: nowrap`.

## Phases

| Phase | Result | Depends on |
| --- | --- | --- |
| [1. Foundation](2026-11-26-field-inspection-ui-phases/phase-1.md) | Tokens, fonts, shared parts, shell, notice pattern, runtime theme. Every page already has the new base look through token aliases. | Juan's approval of this plan |
| [2. Journey 1](2026-11-26-field-inspection-ui-phases/phase-2.md) | Home, the reading state, the report and the agent panel match the canvas. | Phase 1 |
| [3. Journey 2](2026-11-26-field-inspection-ui-phases/phase-3.md) | Sign-in, account, claims, publishing and the published page match the canvas. | Phase 1 |
| [4. Remaining pages and close](2026-11-26-field-inspection-ui-phases/phase-4.md) | Pricing, judges, text pages, conformance, badge, icon. Aliases removed. Full gate and visual review. | Phases 2 and 3 |

Each phase ends with the full local gate (`python3 .rpi/scripts/rpi-verify.py`) on a committed candidate and stops for Juan's acceptance.

## Success criteria

Automated:

1. `python3 .rpi/scripts/rpi-verify.py` passes on the candidate of each phase, and `node tools/release/analyze-evidence.mjs <commit>` reports ACCEPTED: no required test is missing, skipped or failed.
2. `git diff develop -- tools/release/required-tests.json` is empty, and no existing test file changes a title (`git diff develop -- e2e tests | grep '^[-+].*\(test\|it\)("'` shows only added lines).
3. `tests/site/design-tokens.test.ts`: the six tokens have the specified values; each text pair of the contrast table is at least 4.5:1; no file under `src/components` or `src/app` except `globals.css` holds a hex colour; after Phase 4 no `--color-` or `--radius` name remains in `src`.
4. `e2e/field-inspection.spec.ts`: both font families load from the same origin and the condensed width is real (a string at `font-stretch: 62%` is narrower than 75% of its width at 100%); `body` has the same computed colours in light and dark; every button, field, select and summary is at least 44 px high at 390 px; no sideways scroll at 390, 768, 1024 and 1440 px on each page; the runtime panel's consent and send buttons have at least 4.5:1.
5. The existing contrast and 320 px tests pass with unchanged titles.
6. `pnpm vendor:verify` passes: no vendored file changed.

Manual (visual only):

7. Juan compares each page at 1440 and 390 px with the canvas. The implementer puts full-page screenshots of every route and state in `.local/design/field-inspection/app-shots/` beside `shots/`.
8. Juan checks one analysis from URL to report, and one sign-in to publish, on a phone.

## Stuck states and recovery

| State | Who sees what | How it ends | Test |
| --- | --- | --- | --- |
| A font file does not load | The visitor sees the fallback fonts (Helvetica Neue or Arial; a system mono). Wide fallback letters make headings longer. | The layout holds without the fonts; the next page load tries again. No action is needed. | Phase 1: with `**/*.woff2` aborted, the home page and a report at 320 px have no sideways scroll and the `h1` is visible. |
| Evidence is inside a closed check row | The visitor sees the result, the rule, the points and a "+" control on each row. | A click, Enter or Space on the row opens it. Failed rows are open from the start. | Phase 2: a passed row opens with the keyboard and shows its evidence; a failed row shows evidence and the fix without any action. |
| The phone bar covers the bottom of the report | The footer links and the last control could sit under the fixed bar. | The page has bottom padding of the bar's height, and focused elements scroll clear (`scroll-padding-bottom`). | Phase 2: at 390 px the last footer link can be clicked and a focused control's box does not intersect the bar. |
| The runtime cannot start inside the themed panel | The visitor sees the existing alert text (`Preview.tsx:180-184`) in the notice pattern. | The existing paths: another key, or a reload. This plan changes only the look. | Phase 2: the boot-error alert is visible and has at least 4.5:1. |
| A button is disabled before the page's scripts run | The button shows a dashed border and "not-allowed" cursor, not only a lighter colour. | It becomes active on hydration (existing behaviour, `UrlForm.tsx:66`). | Existing: "before hydration the address form's button is disabled and Enter submits nothing". Phase 1 adds a contrast check of the disabled label (at least 4.5:1). |
| The system forces colours (Windows high contrast) | Fills disappear; borders and text stay. | Every control has a real border and real text, so it stays usable. | Phase 1: with `forcedColors: "active"` the address field, its button and the navigation links are visible and have a non-zero border or underline. |
| The reading state waits in the queue | The step list shows "Waiting for a free crawler" as the current step. The bar shows the step's position, not time, so it never shows progress that did not happen. | The existing poll moves the list on; a failure shows the existing notice with Retry. | Phase 2: unit test of `scanSteps` for `queued`, `home`, `probes`, `page 4`, `joined` and unknown steps. |
| A token alias remains after the migration | Nobody sees it; the old and new names would drift. | Phase 4 removes the aliases. | Criterion 3 fails while any `--color-` name remains. |
| A browser holds the old badge image | A site shows the old badge for up to one hour (`BADGE_MAX_AGE_S`, `src/lib/badge/handler.ts:7`). | The cache ends by itself. No site embeds a badge today. | `tests/badge/badge.test.ts` keeps the cache header test. |

## Consumer sweep

Commands: `grep -rlw <Name> src tests e2e --include='*.ts' --include='*.tsx'` for each name, and `grep -rl "var(--color-\|var(--radius" src`.

| Shared thing | Consumers | Covered by |
| --- | --- | --- |
| `SiteNav` | `src/app/page.tsx`, `r/[id]/page.tsx`, `r/[id]/not-found.tsx`, `judges/page.tsx`, `s/[host]/page.tsx`, `account/reports/[id]/page.tsx`, `conformance/page.tsx`, `SitePage.tsx`, `tests/site/site-nav.test.ts` | Phase 1 keeps its markup contract; the pages move to the shell in Phases 2 to 4. |
| `SitePage` | `auth/confirm`, `unsubscribe`, `s/[host]/not-found`, `s/[host]/error`, `bot`, `sign-in`, `account`, `pricing`, `LegalPage` (privacy, terms), `tests/site/site-nav.test.ts` | Phase 1 (shell), then Phases 3 and 4 per page. |
| `StatusMessage` | `SignInForm`, `NotifyForm`, `JudgeForm`, `SaveReportButton`, `ApiKeysSection`, `BillingButton`, `ClaimsSection`, `tests/billing/post.test.ts` | Phase 1. Roles, ids and test ids stay. |
| `ScoreReport` (component) | `AnalysisView`, `s/[host]/page.tsx`, `account/reports/[id]/page.tsx`. The same name in `src/lib/analysis/record.ts`, `src/lib/score/score.ts`, `src/lib/api/status.ts`, `src/lib/api/saved-reports.ts` and `tests/score/score.test.ts` is the data type and does not change. | Phase 2. |
| `ConfirmButton` | `ApiKeysSection`, `ClaimsSection` | Phase 3. |
| `AgentPanel`, `KeyPanel`, `.runtime-surface` | `page.tsx`, `conformance/page.tsx`, `AnalysisView`, `PublishedAgent`, `Preview.tsx`, `tests/billing/judge-form.test.ts`; e2e specs select `.ns-*` classes inside `preview-mount` | Phase 1 (theme), Phase 2 (panels). The runtime's classes are not changed. |
| `badgeSvg` | `src/lib/badge/handler.ts`, `tests/badge/badge.test.ts` | Phase 4. |
| Tokens `--color-*`, `--radius` | 30 files under `src/app` and `src/components` | Phase 1 maps them to the new tokens; Phases 2 to 4 remove the uses; Phase 4 removes the names. |
| Markup-reading unit tests | `tests/site/site-nav.test.ts`, `tests/site/notify-form.test.ts`, `tests/analysis/analysis-status.test.ts`, `tests/analysis/url-form.test.ts`, `tests/accounts/pages.test.ts`, `tests/accounts/confirm.test.ts`, `tests/claims/page.test.ts`, `tests/publish/panel.test.ts`, `tests/billing/judge-form.test.ts`, `tests/billing/api-keys-section.test.ts` | Each phase runs them; D6 keeps what they read. |
| Excluded: `e2e-prod/` | Reads headings and `#site-url-error` in production. | No change needed (D6). It runs only in a release. |

## Batch eligibility

Phases 2, 3 and 4 name units with separate file sets, marked `[batch-eligible]`. At most three implementers work at once, each in its own worktree under `.local/worktrees/`, with one integration owner who merges locally into the phase branch. A unit runs typecheck, lint and unit tests in its worktree. Only the integration owner runs Playwright, once per merged state, because two worktrees cannot use port 3010 at the same time (`docs/development/resource-lifecycle.md`). No working branch is pushed and no pull request is opened.

## Risks

- The vendored runtime has fixed colours that no variable reaches (for example white cards at `ui.js:153`). The panel therefore keeps a white surface inside an ink frame. If a release-required contrast test fails inside the runtime, the fix is in the variables or the wrapper rules, never in the vendored file.
- Archivo at 62% width is wide in the fallback font. The font-blocked test in Phase 1 guards the layout.
- A fixed light theme removes dark mode for visitors who had it. D2 records this as accepted.
- New home copy is marketing text. It makes no claim beyond the product's existing texts; Juan reads it in the visual review.

## Handoff

- Objective and scope: as above. Approved so far: the design (D0). Not approved: implementation of any phase.
- Base: `develop` `474e366`, clean tree, checkout `/Users/juan/code/retrofit`. The plan and phase files are new and not committed.
- Evidence limits: the colour facts were read from Cognizant's public stylesheet and the Devpost rules page on 2026-11-26. The font packages' file lists were read from the registry mirror; the packages are not installed. Tailwind 4 container-query utilities were not checked; the plan uses plain CSS for them. The canvas was render-checked at 320 to 1440 px on 2026-11-26 before the colour change, and four boards were rendered again after it.
- Next phase: `/rpi-implement` Phase 1 in a worktree off `develop`, after Juan approves this plan. On resume, compare `git rev-parse develop` with `474e366` and read the files cited in "Current state" again if it moved.
- Local resources: none allocated. Another session's review server (background shell "Start the review server with the dev environment") was running during planning and was not touched.
