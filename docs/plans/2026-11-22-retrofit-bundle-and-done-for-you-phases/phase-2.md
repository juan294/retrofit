# Phase 2: download endpoint, install panel and an end-to-end install

Parent plan: [2026-11-22-retrofit-bundle-and-done-for-you.md](../2026-11-22-retrofit-bundle-and-done-for-you.md).

## Entry conditions

- Phase 1 accepted (or continuation authorized). Rebase the phase branch on current `develop` and record which of Juan's UI commits it includes.
- Port 3015 added to `docs/development/resource-lifecycle.md` as "loopback server for the unzipped bundle, started and closed by `e2e/bundle-install.spec.ts`" before the first e2e run.

## Changes

1. `src/lib/preview/artifacts.ts`: `bundle.zip` is resolved before the other names in `resolveArtifact` (`artifacts.ts:43`) and served by a new `serveBundle` that calls `bundleFiles` and `writeZip`, with the headers in the parent plan. The owner check, expiry, not-ready and generation-failed paths stay shared with `handlePreviewFile` (`artifacts.ts:88`), so the texts cannot drift. Compressed vendored entries are cached per process.
2. `src/components/analysis/InstallPanel.tsx`: heading, sentence, the download link and the install line from the parent plan. It renders only for a ready analysis with a score report, after `AgentPanel` (`AnalysisView.tsx:175`). The done-for-you line arrives in Phase 3; this phase leaves a slot for it.
3. `e2e/bundle-install.spec.ts` (CSP fixture imported, as the lint rule requires):

```
@ bundle install e2e
ctx: Playwright server :3010 (fixtures mode), bakery fixture, mock router, serve_site.mjs :3015
pre: port 3015 free (fail the test with the owner pid if not)
do:
  1. analyze the bakery fixture; click "Download the files"; save the zip
  2. extract with python3 -I -m zipfile -e into a temp folder
  3. start serve_site.mjs on site/ at 127.0.0.1:3015 (recorded pid, closed in afterAll)
  4. open /assistant/, see the key status, connect a mock key, ask about opening hours
  5. emit checks: tool round trip, source link, check_partner.mjs exit 0, score checks aw.* pass
fx: temp folder and server removed in afterAll
```

   The score assertion calls Retrofit's score code against `http://127.0.0.1:3015` the way `tests/fetch/*` reaches loopback fixtures, or through the fixtures-mode analyze route if it already accepts loopback origins; the implementer records which in the notes.
4. `tests/preview/bundle-route.test.ts`: owner 200 with headers and a zip Python accepts; other browser 404 text; expired 410 text; not ready 404; forced validator failure 404 `generation_failed`; store failure 503.
5. `tests/perf/bundle.perf.test.ts`: 20 sequential downloads on the perf server (port 3014), p95 under 500 ms, zip under 2 MB.
6. `e2e/phone-width.spec.ts` and `e2e/preview-theme.spec.ts` run with the panel present; extend the width test to a results page with the panel.

## Exit criteria

- Parent success criteria 5, 6 and 8 pass; 7 for the panel without the email line.
- Full gate, analyzer ACCEPTED, required tests updated. The bundle server on 3015 is closed and no process is left (record the check).
- Review, repair, simplify, handoff. Stop for acceptance.
