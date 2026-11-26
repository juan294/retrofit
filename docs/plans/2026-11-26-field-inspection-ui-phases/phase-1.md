# Phase 1: Foundation

Part of [the Field Inspection UI plan](../2026-11-26-field-inspection-ui.md). Read its "Design specification" and decisions D1 to D9 first.

## Entry conditions

- Juan approved the plan.
- A worktree off `develop` at the plan's base, or a newer `develop` after the cited files were read again.
- `pnpm add @fontsource-variable/archivo@5.3.0 @fontsource/ibm-plex-mono@5.3.0` is allowed as a dependency change (two OFL-1.1 packages, pinned in the lockfile).

## Changes

This phase is sequential: every later unit depends on its output.

### 1. Tokens and base styles: `src/app/globals.css`

- Add the six `--fi-*` tokens and remove the dark block (`globals.css:17-29`). Set `color-scheme: only light` (D2).
- Keep the old names as aliases so that every untouched page passes the contrast tests at once: `--color-bg` and `--color-surface` to paper and white, `--color-text` and `--color-muted` to the ink, `--color-border` to the ink, `--color-accent` to the ink with `--color-accent-text` paper, `--color-danger` and `--color-ok` to the ink, `--radius: 0`. Meaning that colour carried before (danger, ok) is carried by the notice pattern and by words from now on.
- Add component classes in `@layer components`: display heading, mono label, panel, raised panel, stripe, stamp, button (primary, accent, quiet), field, select, check and radio, code block, notice. Values come from the specification.
- Add the wrap rule, the focus rule, the disabled rule (dashed border, `cursor: not-allowed`) and the reduced-motion rule.
- Replace the dark runtime override (`globals.css:40-48`) with the theme of D5 for every scheme. Keep the two wrapper rules (`globals.css:51-57`).

### 2. Fonts: `src/app/fonts.ts`, `src/app/layout.tsx`

```
@ fonts.ts -> { display, mono }
ctx: next/font/local; files in node_modules/@fontsource-variable/archivo and @fontsource/ibm-plex-mono
pre: read font.md "Local Fonts" and "declarations" in node_modules/next/dist/docs first
do:
  1. validate the wdth file holds both axes (test 3 below proves it)
  2. write Archivo as one variable face: weight "100 900", declarations font-stretch "62% 125%"
  3. write IBM Plex Mono as three faces: 400, 500, 600
  4. emit CSS variables --font-display and --font-mono on <html>
fail: a missing axis -> use archivo-latin-wdth-normal for display and archivo-latin-wght-normal for body
risk: a path into node_modules must resolve in next build and in a worktree
```

`layout.tsx` keeps `await connection()` (`layout.tsx:13`) and adds only the font classes and the shell container.

### 3. Shared parts: `src/components/ui/`

`Button` (also renders as a link), `Field`, `Select`, `Panel`, `MonoLabel`, `Stripe`, `Stamp`, `CodeBlock`, `Notice`. Each takes `className` and passes every other attribute through, so ids, `aria-*`, `data-testid` and `{...buttonState()}` keep working.

```
@ Notice({ tone, title?, children, role? }) -> element
ctx: none
pre: tone is "action" (accent header) or "info" (ink header)
do:
  1. write a bordered panel with a header strip in the tone's colour
  2. write the title in the strip when given, else a mono label
  3. write children below, as given
br: role given -> put it on the body element, never on the wrapper
risk: a role on the wrapper would announce the title on every render
```

### 4. Shell: `SiteNav`, `SitePage`, new `SiteHeader`, `SiteFooter`, `PageShell`

- `SiteNav` stays a `<nav aria-label="Retrofit">` whose first three children are the plain links "Retrofit", "Pricing", "Account" in that order, with no `<p>` (`tests/site/site-nav.test.ts:10-19`). The wordmark style goes on the first link.
- `SiteHeader` wraps `SiteNav` and the form label ("Form R-01 · …"). `SiteFooter` holds the five footer links now in `src/app/page.tsx:34-50` and the wordmark. `PageShell` is the container (`container: page / inline-size`) with header, `<main>` and footer.
- `SitePage` uses `PageShell` and keeps its props. In every page that uses it, the navigation links stay the first three links of the markup.
- `StatusMessage` keeps its two regions, ids and test ids (`StatusMessage.tsx:26-33`) and takes the notice look for a failure.

## Tests and oracles

1. `tests/site/design-tokens.test.ts`: token values; the contrast table; no hex colour in `src/components` and `src/app` outside `globals.css`.
2. `tests/site/site-nav.test.ts` passes without change.
3. `e2e/field-inspection.spec.ts`, first part: fonts from the same origin; condensed width is real; `body` colours equal in light and dark; forced colours keep the address form usable; with font files blocked, `/` at 320 px has no sideways scroll.
4. The existing suite, unchanged, including every "readable in dark mode" and "fits a 320 px" test.

## Exit criteria

- `python3 .rpi/scripts/rpi-verify.py` passes on the committed candidate; the analyzer reports ACCEPTED.
- `pnpm vendor:verify` passes.
- Screenshots of `/`, a report, `/account` and `/pricing` at 1440 and 390 px are in `.local/design/field-inspection/app-shots/phase-1/`. They show the new fonts, colours and shell on pages whose layout is still the old one.
- Stop for Juan's acceptance.
