# Phase 1: bundle builder and zip writer

Parent plan: [2026-11-22-retrofit-bundle-and-done-for-you.md](../2026-11-22-retrofit-bundle-and-done-for-you.md). Read its Design and Success criteria first.

## Entry conditions

- Owner accepted the plan.
- Worktree from current `develop` (for example `/Users/juan/code/retrofit-worktrees/bundle`, branch `feat/bundle-builder`). Record base commit in the notes file.
- `git ls-remote https://github.com/cognizant-ai-labs/agentic-web HEAD` recorded; if it changed `skills/agentify-website/runtime`, `scripts` or `templates` since `0516537`, stop and report (a re-vendor comes first).
- Create `docs/plans/2026-11-22-retrofit-bundle-and-done-for-you-notes.md` with the base, the specification commit and a deviations table.

## Changes

### Unit A `[batch-eligible]`: zip writer

Files: `src/lib/bundle/zip.ts`, `tests/bundle/zip.test.ts`. No dependency on Unit B.

```
@ writeZip(entries[{path, bytes}]) -> Uint8Array
ctx: node:zlib deflateRawSync, crc32
pre: paths validated (relative, "/" separated, no "..", no leading "/", no "\\", no NUL)
do:
  1. validate every path and refuse duplicates (throw)
  2. compute crc32 and deflated bytes per entry (stored when deflate is larger)
  3. write local headers, data, central directory, end record (UTF-8 flag set)
fail: invalid or duplicate path -> throw BundleError
risk: zip64 not supported; refuse total size above 64 MB
```

Tests (TDD, red first): Python `zipfile` (`python3 -I -m zipfile -t`, and `-e` into a temporary folder) accepts the output and returns the same bytes; path refusals; an empty file; a file that deflate grows; a fixed `mtime` so output is deterministic (same input, same bytes).

### Unit B `[batch-eligible]`: bundle file set

Files: `src/lib/generate/network.ts` (the `target` option), `src/lib/bundle/files.ts`, `src/lib/bundle/assets.ts` (reads `public/runtime/**`, `public/preview-assets/content-actions.js`, `tools/agentic-web/templates/assistant.css` once per process), `src/lib/bundle/readme.ts`, `tests/bundle/files.test.ts`, `tests/bundle/oracle.test.ts`, `tests/generate/network.test.ts`.

```
@ bundleFiles(snapshot) -> {topFolder, entries[]}
ctx: generateNetwork(target "bundle"), assets
pre: snapshot from a ready analysis
do:
  1. compute generated (network, manifest, siteContent)
  2. compute discovery files and bridge files with the same bytes as build_network.mjs
  3. compute assistant/index.html, assistant/site.js, README.md, hosting/* from host and date
  4. emit entries under "<topFolder>/site/..." and "<topFolder>/..."
fail: GenerationFailed -> rethrow
risk: build_network.mjs changes on re-vendor; oracle test fails first
```

The assistant page and `site.js` are Retrofit files derived from `templates/standalone-index.html` and `templates/site.js`: no `script.js` import, no `DIALOGS` (no irreversible action), `GREETING` "I answer questions about <host> from its public pages, saved on <date>." The vendored templates stay unchanged.

README sections, in this order: what this is (one paragraph, "for a site you own"); "Before you copy" (every `site/` path, stop and email if one exists); "Install" (copy `site/` to the web root, add the header rules from `hosting/`, open `/assistant/`, add a link to `/assistant/` in the menu); "What visitors need" (their own AI key; the default router is Otari; how to point `llm_router` at another router); "What data leaves the page" (the visitor's messages and the page data the agent reads go to the visitor's AI provider; reference "The README"); "Keep it current" (analyze again, download again; the snapshot date); "Get help" (the lead address, `LEAD_EMAIL = "retrofit@thecreativetoken.com"`, added to `src/lib/site/own-site.ts` in this phase; nothing is released before Phase 3 confirms the alias works); license note for `runtime/` (Apache-2.0, `runtime/LICENSE.txt`).

## Tests and oracles

- `tests/bundle/oracle.test.ts`: for each fixture site in `tests/helpers/fixture-snapshots.ts`, write the bundle's `site/` to a temporary folder, run `build_network.mjs <network>.hocon --manifest agent-manifest.json --runtime tools/agentic-web/runtime --out <network>.network.json` (as `tests/generate/oracle.test.ts` does, with the network JSON as the HOCON input) in a second folder, and require exit 0 and byte equality for `<network>.network.json`, `agent-mcp.json`, both `.well-known` files and both `bridge/` files. A negative case (a front man that names a missing tool) must exit non-zero, so the oracle can fail.
- `tests/bundle/files.test.ts`: runtime byte equality and count; the README lists every `site/` path; no `.htaccess`, `_headers` or `vercel.json` under `site/`; no file under `site/` contains `/api/inference` or `thecreativetoken.com` (the README, which names Retrofit and the lead address, sits outside `site/`); host and date in the instructions, README and greeting; hostile fixture: no snapshot page text appears in any generated HTML, JavaScript or Markdown file.
- `tests/generate/network.test.ts`: `target` omitted equals today's output for every fixture (pinned JSON written by reasoning from the current code before the change, then checked red against a deliberately altered generator); `target: "bundle"` changes exactly the four fields in the plan.

## Exit criteria

- Success criteria 1 to 4 of the parent plan pass.
- Full gate passes on the phase head, analyzer ACCEPTED, new tests listed in `tools/release/required-tests.json`.
- Independent review, repair and simplify done; handoff in the notes file. Stop for acceptance.
