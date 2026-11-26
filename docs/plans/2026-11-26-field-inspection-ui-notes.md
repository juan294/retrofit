# Field Inspection UI implementation

Juan approved Phase 1 on 2026-11-26 ("commit the plan and /rpi-implement phase 1"). Phases 2 to 4 are not approved. The base is `develop` `9bac51d` (the plan commit, on `474e366`). The implementation branch is `feat/field-inspection-p1` in `/Users/juan/code/retrofit/.local/worktrees/field-inspection-p1`. No project rpi-implement overlay is installed. The handoffs follow 2026-11-26-field-inspection-ui.md.

## Deviations

| Plan said | Found | Chose | Why |
| --- | --- | --- | --- |
| Fluid sizes use the page as a container (`container: page / inline-size`, `cqw`, `@container page (max-width: 760px)`). | The shell is `<body>`, so the container is always the viewport. | Viewport units (`vw`) and `@media (max-width: 760px)`. | The result is the same, and no page behaviour depends on containment. VERIFIED in Chromium 159: a fixed element inside an `inline-size` container still uses the viewport. INFERRED from memory, not tested: older engines applied layout containment, which would trap the runtime's modal and the phone bar of Phase 2. |
| A `SiteHeader` component wraps `SiteNav` and the form label. | The navigation tests need the three links first and in order, also when a page renders `SiteNav` alone. | `PageShell` renders the `<header>`; `SiteNav` takes an optional `form` label and is the bar itself. | The seven pages that still build their own `<main>` get the wordmark and the links in the new look without a change. |
| `PageShell` is the container. | Next.js adds its own elements to `<body>`. | The shell class `fi-shell` is on `<body>` (`src/app/layout.tsx`); `PageShell` is header, children and footer. | Every page, also the not-found and error pages, gets the paper, the fonts and the column from one place. |
| Fonts emit `--font-display` and `--font-mono`. | Tailwind's theme owns `--font-mono`. | `--fi-font-archivo` and `--fi-font-plex` from `next/font/local`; the stylesheet builds `--fi-font-body` and `--fi-font-mono` from them. | No clash with the framework's names. One Archivo face serves body and display text: the width axis makes the difference. |
| D9: only assertions that name the old home `h1` change. | `tests/billing/post.test.ts` compares the whole failure markup of `StatusMessage`, including the old inline colour. | That one assertion now expects the notice markup. The title is unchanged, and the test still fails if the status region is not mounted, the failure is not an alert, or the id and test id are not on the element with the text. | The plan gives `StatusMessage` the notice look; the old string could not stay. |
| Tokens map the old names to the new ones. | The old boxes and buttons also use the utilities `rounded` and `border` (46 and 35 uses), and their buttons set colours inline. | Two unlayered rules square `.rounded` and give `.border` the 3 px line; the disabled-button rule uses `!important`; `[role="alert"]` outside a notice gets an ink bar. Phase 4 removes the first three (added to phase-4.md). | Without them the old pages keep round corners and hairlines until their phase, and a disabled old button keeps its ink fill. |
| The mono family preloads like the display family. | Three mono files, and most pages use one or two. | `preload: false` and no generated fallback face for the mono family. | Each file loads when a text needs it. The generated fallback is a resized Arial, which would stand before the system mono fonts. |
| The home page keeps its own footer until Phase 2. | `SiteFooter` holds the same five links. | The home page renders `SiteFooter` now. | One list of footer links. |

## Phase 1

The token test was written first and failed for 17 of its 19 cases before the stylesheet changed. The browser tests need a build, so their first run was after the implementation; the review below names, for each, the production change that makes it fail.

What exists now: six `--fi-*` tokens and no dark set; Archivo (variable, 90 KB) and IBM Plex Mono (three files of 15 KB) served from the app's own origin; the parts `Button`, `ButtonLink`, `Field`, `Select`, `Panel`, `MonoLabel`, `Stripe`, `Stamp`, `CodeBlock` and `Notice` in `src/components/ui/`; `PageShell`, `SiteFooter` and the restyled `SiteNav` and `SitePage`; `StatusMessage` shows a failure as a notice; the runtime panel takes its colours and font from the `--ns-*` variables with the ink as its primary. Pages that are not moved yet keep their layout and take the new colours, fonts and edges through the old token names.

Independent review (fresh context, read-only) returned CHANGES REQUIRED with eight findings and no blocker. Dispositions:

| ID | Finding | Disposition |
| --- | --- | --- |
| R1 | `.fi-btn` set `cursor: pointer` in a later layer than the disabled cursor. | Resolved: the line is gone, and a token test fails if the class sets a cursor again. |
| R2 | The mono family's generated fallback face (a resized Arial) stood before the system mono fonts; the fallback list was written twice. | Resolved: `adjustFontFallback: false`, one list in `globals.css`, and the blocked-font test reads the second family of the address field. |
| R3 | No versioned record of the deviations; the temporary rules were not in Phase 4's removal list. | Resolved: this file, and phase-4.md "Close" and its test line. |
| R4 | The paper focus ring of ink surfaces reached into the runtime panel. | Resolved: the rule excludes `.runtime-surface`. |
| R5 | With a form label at 760 px or less, the page links lost their push to the far side. | Resolved by a simpler rule: the second link takes `margin-left: auto` in every case. |
| R6 | The contrast cases were arithmetic on pinned constants, and a missing token passed through a fallback. | Resolved: a missing token throws; a new case fails if any rule uses the accent as a text colour outside an ink surface. The contrast table stays, because the plan's criterion 3 names it. |
| R7 | The blocked-font test did not assert the report's `h1`. | Resolved. |
| R8 | `Stripe` took only `className`. | Resolved: it passes other attributes through. |

The second review round found R1 to R8 resolved and approved the phase, with two notes:

| ID | Finding | Disposition |
| --- | --- | --- |
| N1 | The accent-colour case could accept a selector that only excludes the ink, or a list with one part off the ink, and read a comment as a selector. | Resolved: comments are dropped, each part of a list must start with `.fi-on-ink`, and the case proves its own check on a three-rule probe. |
| N2 | With `preload: false` the mono file loads on the home page only because the empty address field shows a placeholder. | Rejected with evidence: "both font families load from Retrofit's own origin" passed after the change, in a focused run and in the gate. A placeholder is rendered text, so the browser loads its font. |

The simplify pass was done in this session without subagents, because the change is small. Applied: one `fits` helper in `e2e/support/layout.ts` for `phone-width.spec.ts` and the new spec; one footer; one navigation rule in place of three; no preload of the mono files. Skipped: the contrast function in `tests/site/design-tokens.test.ts` repeats arithmetic that `e2e/preview-theme.spec.ts` runs inside the browser; the two cannot share code.

Screenshots of `/`, a report, `/pricing` (with a failure notice), `/account` and `/sign-in?link=expired` at 1440 and 390 px are in `/Users/juan/code/retrofit/.local/design/field-inspection/app-shots/phase-1/`. The test that takes them is `/Users/juan/code/retrofit/.local/design/field-inspection/tools/phase-1-shots.spec.ts`; copy it into `e2e/` to run it and remove it afterwards.

### Gate result

The gate ran on `616765011ae7d47e84a7ff8cefe1bbad07c74983` (branch `feat/field-inspection-p1`). 14 of 15 checks passed: whitespace, RPI installation, evidence begin, vendor verify, agent check, peer check, typecheck, lint, 2,279 unit tests, coverage (statements 93.14%, branches 86.91%), build, 3 performance tests, 188 browser tests and the evidence seal. The browser tests include every release-required contrast and 320 px test, with unchanged titles, and the seven new ones.

`db-tests` did not run and exited 4: `supabase start` could not start the disposable `retrofit-gate` stack. Its ports 54731 and 54732 were held by the containers `supabase_kong_chapa-p2fix` and `supabase_db_chapa-p2fix` of another project, created on 2026-11-26 at 12:12 UTC. The gate did not touch them. Its teardown completed, and no `retrofit-gate` container, volume, network or receipt remains. The analyzer therefore rejects the candidate with three reasons, all of them the missing database report.

Phase 1 changes no file under `supabase/`, `src/lib/accounts/` or `tests/db/` (`git diff 9bac51d 6167650 --stat`). That is context, not a replacement for the check. Phase 1 is not accepted until the full gate passes on the candidate with the ports free. The raw log is `/Users/juan/code/retrofit/.local/runs/2026-11-26-field-inspection/gate-p1-6167650.log`.

### For Phase 2

- `e2e/own-site.spec.ts` reads the first `<p>` inside `<main>` on the home page as the intro. The new hero's small label above the headline must not be a `<p>`, or it must come after the intro in the markup.
- The runtime's own corners (chat box, agent list, buttons) are still round: its styles are injected unlayered, so a wrapper rule needs two classes, for example `.runtime-surface .ns-chat`. Phase 2 Unit C owns that.
- No page passes a `form` label to `SitePage` or `SiteNav` yet.
- `Button`, `Field`, `Select`, `Panel`, `MonoLabel`, `Stripe`, `Stamp` and `CodeBlock` have no user yet.
