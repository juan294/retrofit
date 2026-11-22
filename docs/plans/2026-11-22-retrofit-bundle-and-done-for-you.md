# Plan: Retrofit install bundle and done-for-you contact

> Created 2026-11-22 with `rpi-plan`. Status: proposed, waiting for owner acceptance. Phase files: [phase-1](2026-11-22-retrofit-bundle-and-done-for-you-phases/phase-1.md), [phase-2](2026-11-22-retrofit-bundle-and-done-for-you-phases/phase-2.md), [phase-3](2026-11-22-retrofit-bundle-and-done-for-you-phases/phase-3.md). Notes file (created at Phase 1 entry): `2026-11-22-retrofit-bundle-and-done-for-you-notes.md`.

## Objective

A visitor who analyzed a site can download a zip of static files, put them on that site, and get a working agent on the site's own origin. A visitor who does not want to do that can ask Retrofit to do it, by email. This completes steps 4 and 5 of the accepted flow in [the design brief](../research/2026-11-14-retrofit-brief.md) (lines 50 and 95) without ownership claims.

## Scope

In scope:

1. A bundle builder that turns a ready analysis into the companion-assistant file set of the organizers' reference (`skills/agentify-website/references/bundle_and_hosting.md` and `live_url_mode.md` at `cognizant-ai-labs/agentic-web` `e34299792cb85f6eb27fed896fdedf65880b458b`).
2. A download endpoint for the analysis owner, and an "Install it on your site" panel on the results page.
3. A done-for-you call to action on the results page and the home page, with the address `retrofit@thecreativetoken.com`.

Out of scope (owner, 2026-11-22): ownership claims by meta tag or DNS, official publishing, the badge, payment and accounts, a stored contact form, and site actions other than the two read tools.

## Owner decisions (2026-11-22)

| Decision | Answer | Effect |
| --- | --- | --- |
| Who may download a bundle | The analysis owner, with no claim | Same access rule as the preview (`src/lib/preview/artifacts.ts:88`). A decision record narrows the brief's "a claim unlocks the install" (brief line 56, `AGENTS.md` "Product and data constraints") to Retrofit-hosted publishing. |
| Lead channel | Email link | A `mailto:` link with the site and score in the subject. Retrofit stores nothing. |
| Lead address | New alias `retrofit@thecreativetoken.com` | One SES receipt rule change, an external action that needs its own authorization in Phase 3. |
| Install shape | Root files and an `/assistant/` page | Matches the organizers' output layout. After install, Retrofit's own `aw.manifest`, `aw.network-valid` and `aw.cors` checks (30 points, `src/lib/score/checks.ts:14-16`) can pass for the site. |

Already accepted and kept: write-confirmation option 1 (no write actions here, so it does not apply); the visitor's key never reaches Retrofit; previews stay private and labelled unofficial.

## Current state (verified 2026-11-22 on `develop` `d126b83`)

- `generateNetwork` builds the preview's network, manifest and `site-content.json` from a snapshot (`src/lib/generate/network.ts:163`). The manifest routes the model through Retrofit's free proxy (`network.ts:189`) and is branded `<host> preview` (`network.ts:185`). The instructions say "I can't do this for you in this preview." (`network.ts:149`).
- `/p/<id>/<file>` serves those files and the vendored `content-actions.js` and `bridge/*` only to the analysis owner (`src/lib/preview/artifacts.ts:43`, `:88`), with `private, no-store` (`artifacts.ts:24`).
- The results page shows the score, "Fix these first" and the preview (`src/components/analysis/AnalysisView.tsx:142`, `:175`). There is no download and no done-for-you text. The home page's only contact link goes to public GitHub issues (`src/lib/site/own-site.ts:11`, `src/app/page.tsx:33`).
- The vendored runtime in `public/runtime/` equals `tools/agentic-web/runtime/` (`diff -rq`, no difference), 3.9 MB, of which `generated/agent-runner.bundle.js` is 3.0 MB. Templates are in `tools/agentic-web/templates/`. The organizers' scripts are `tools/agentic-web/scripts/build_network.mjs` (writes `agent-mcp.json`, `.well-known/nsdeploy.json`, `.well-known/nsdeploy-agent.json`, `bridge/action-bridge.html` and `bridge/agent-manifest.json`, lines 10-13 and 729-731), `check_partner.mjs` and `serve_site.mjs`.
- `tests/generate/oracle.test.ts` already runs `build_network.mjs` on generated networks and requires exit 0 and equal output.
- Playwright runs one worker (`playwright.config.ts:8-9`).
- AWS SES on `thecreativetoken.com` receives mail for `juan@thecreativetoken.com` (rule `juan-tct-forward`, S3 and Lambda actions) and `support@chapa.thecreativetoken.com`. No `retrofit@` recipient exists (`aws ses describe-active-receipt-rule-set`, read only).

## Design

### Bundle layout

The zip is named `retrofit-<host>-<snapshot date>.zip`. Every file sits under one top folder with the same name, so unzipping never writes into the current folder. Inside it, `site/` holds what goes on the web root, and `README.md` and `hosting/` stay off the site:

```text
retrofit-<host>-<date>/
  README.md                         install steps, file list, data and key notes, refresh steps
  hosting/_headers                  Netlify and Cloudflare Pages header rules (reference "Static hosting")
  hosting/htaccess-snippet.txt      Apache rules to merge into an existing .htaccess, never a file named .htaccess
  hosting/vercel-headers.json       a "headers" array to merge into vercel.json
  site/agent-manifest.json          bundle manifest (see below)
  site/<network>.network.json       same network as the preview, bundle wording
  site/site-content.json            the snapshot (`toSiteContent`)
  site/content-actions.js           vendored, unchanged
  site/links.json                   {"version":1,"networks":{}}
  site/agent-mcp.json               as build_network.mjs writes it
  site/.well-known/nsdeploy.json    as build_network.mjs writes it
  site/.well-known/nsdeploy-agent.json
  site/bridge/action-bridge.html    as build_network.mjs writes it
  site/bridge/agent-manifest.json   as build_network.mjs writes it
  site/runtime/**                   vendored runtime, byte for byte
  site/assistant/index.html         Retrofit page from templates/standalone-index.html
  site/assistant/site.js            Retrofit boot script from templates/site.js, without the page-script import
  site/assistant/assistant.css      vendored templates/assistant.css
```

`site/assistant/site.js` boots with `originUrl` = the site root (`new URL("../", import.meta.url)`) and `sandboxWorkerUrl` = `<root>/runtime/sandbox-worker.js`, so the manifest, network, links and actions resolve from the root as the runtime expects (reference "Mounting").

### Bundle manifest and network

`generateNetwork` gains a `target: "preview" | "bundle"` option. `"preview"` output stays byte-identical to today (a test pins it). `"bundle"` changes only:

- `brand`: `<host> assistant`; `networks[0].description`: `Answers questions about <host> from its public pages, saved on <date>.`
- `llm_router.base_url` = `byok_router` = the Otari row's router (`network.ts:17`), the template default; no Retrofit URL anywhere in the bundle except the README's "built by" line.
- `linking.exports[0].url`: the network name, as today.
- The order or booking sentence: `say "I can't do this for you here."`

```
@ buildBundle(snapshot, assets) -> {fileName, files[]}
ctx: generateNetwork(target "bundle"), vendored runtime and templates (read once per process)
pre: analysis ready and owned by the requester; snapshot validates
do:
  1. compute generated = generateNetwork(snapshot, target "bundle")
  2. compute discovery and bridge files (same bytes as build_network.mjs)
  3. compute assistant page, site.js, README, hosting files from host and date only
  4. write zip entries (deflate, CRC-32 from node:zlib) under the top folder
fail: GenerationFailed -> 404 generation_failed (same text as the preview)
risk: build_network.mjs output drifts on re-vendor; the oracle test catches it
```

Only the validated host (`validatedHost`, `network.ts`) and the snapshot date enter generated HTML, JavaScript and Markdown, as in the preview generator. Page titles and text stay inside `site-content.json`, where the runtime treats them as tool data.

### Download endpoint

`GET /p/<id>/bundle.zip`: same owner check, expiry and generation errors as `handlePreviewFile` (`artifacts.ts:88`). Success: `200`, `content-type: application/zip`, `content-disposition: attachment; filename="<zip name>"`, `cache-control: private, no-store`, `x-robots-tag: noindex`. Compressed vendored entries are built once per process; per request only the generated files are compressed.

### Results page

A new component `src/components/analysis/InstallPanel.tsx`, placed after the preview in `AnalysisView.tsx` with a one-line change, so it does not collide with the owner's UI pass. It has:

- heading "Put this agent on your site", one sentence, a "Download the files" link to `/p/<id>/bundle.zip`, and the line "For a site you own. Unzip, copy the `site` folder to your web root, then open `/assistant/`. The README has the details.";
- the done-for-you line: "Rather have us do it? Email retrofit@thecreativetoken.com" as a `mailto:` link with subject `Retrofit install for <host> (score <n>)`.

The home page gets one sentence with the same address, and `own-site.ts` gains `LEAD_EMAIL` and a second JSON-LD `Service` ("Done-for-you agentic website setup") with that contact. `CONTACT_URL` stays the GitHub issues link for bugs.

## Phases

| Phase | Result | Depends on |
| --- | --- | --- |
| [1](2026-11-22-retrofit-bundle-and-done-for-you-phases/phase-1.md) | Bundle builder and zip writer, proved against the organizers' scripts | none |
| [2](2026-11-22-retrofit-bundle-and-done-for-you-phases/phase-2.md) | Download endpoint, install panel, and an end-to-end install on a loopback origin | 1 |
| [3](2026-11-22-retrofit-bundle-and-done-for-you-phases/phase-3.md) | Done-for-you contact, the SES alias, the decision record and release inputs | 2 for the results-page line; the SES step is independent |

Phases run in order with an acceptance stop after each, unless Juan authorizes continuation. Each phase follows implement, independent review, repair, simplify, full gate (`python3 .rpi/scripts/rpi-verify.py`, then `node tools/release/analyze-evidence.mjs <commit>`).

## Success criteria

Automated (each named test is added to `tools/release/required-tests.json`):

1. `build_network.mjs` run on the bundle's manifest and network exits 0, and every file it writes equals the bundle's copy byte for byte, for every fixture site (`tests/bundle/oracle.test.ts`).
2. Every `site/runtime/**` entry equals `public/runtime/**` byte for byte, and the file count matches (`tests/bundle/files.test.ts`).
3. `python3 -I -m zipfile -t` accepts each fixture bundle, and every entry path starts with the top folder, has no `..`, no absolute path and no backslash (`tests/bundle/zip.test.ts`).
4. The preview's generated output is unchanged for every fixture site (`tests/generate/network.test.ts`, pinned).
5. The download returns 200 with the headers above to the owner; the other-browser 404, 410 for expired and 404 `generation_failed` match the preview's texts (`tests/preview/bundle-route.test.ts`).
6. End to end (`e2e/bundle-install.spec.ts`): download from the results page, unzip with Python, serve `site/` with `serve_site.mjs` on `127.0.0.1:3015`, open `/assistant/`, connect a mock router key, ask one question, see a `website_search_site_content` round trip and a source link; zero CSP violations on the Retrofit pages; `check_partner.mjs http://127.0.0.1:3015/<network>` exits 0; Retrofit's score checks `aw.manifest`, `aw.network-valid` and `aw.cors` pass against the served folder.
7. The results page and home page show the address and a `mailto:` link with the encoded subject; the phone-width tests pass at 320 px with the panel present (`e2e/phone-width.spec.ts`).
8. The bundle route's p95 stays under 500 ms over 20 sequential downloads on the perf server (`tests/perf/bundle.perf.test.ts`), and the zip is under 2 MB for the largest fixture.

Manual (owner):

1. Unzip one real bundle, read the README as a site owner, and say whether the steps are clear.
2. Send one email to `retrofit@thecreativetoken.com` after the SES change and confirm it arrives.
3. Look at the install panel in light and dark mode during the UI pass.

## Stuck states and recovery

| State | Who sees it, and what | How it ends | Test |
| --- | --- | --- | --- |
| Analysis expired | Owner clicks Download: the browser gets 410. The results page already shows "expired on <date>" with "Analyze again", and the panel is not rendered for expired analyses | "Analyze again" starts a new analysis | `tests/preview/bundle-route.test.ts` (410 text), `e2e/bundle-install.spec.ts` (no panel when expired) |
| Generation fails | The panel is not rendered, because the preview shows "Retrofit could not build a working agent for this site."; a direct request returns 404 `generation_failed` with that text | The visitor analyzes again later or emails the lead address shown on the page | route test with the forced validator failure that `artifacts.test.ts` already uses |
| Other browser or no cookie | 404 with the existing other-browser text, which says to open the link in the browser that started the analysis | Visitor uses that browser or analyzes again | route test |
| Store unavailable | 503 with the existing unavailable text | Retry later; nothing is cached | route test |
| Installed files collide with the owner's paths (`runtime/`, `bridge/`, `assistant/`, `links.json`, `.well-known/nsdeploy*.json`, `agent-mcp.json`, `agent-manifest.json`) | Owner, before copying: the README lists every path first and says to stop and email the lead address if one exists | Owner keeps their files and emails; no `.htaccess` or `_headers` is ever placed in `site/` | `tests/bundle/files.test.ts` asserts the README lists every `site/` path and that `site/` contains no `.htaccess`, `_headers` or `vercel.json` |
| Installed assistant without a key | Site visitor: the runtime's own "needs your AI provider key" status (`templates/site.js` behavior) | Visitor adds a key in AI model settings; the README tells the owner they can point `llm_router` at their own router | e2e checks the status text before the key and the answer after it |
| Snapshot goes stale on the owner's site | Site visitor: answers carry the snapshot date and source links (instructions) | Owner re-analyzes and downloads again; README "Keep it current" | `tests/bundle/files.test.ts` asserts the date in the network instructions and README |
| SES alias not active yet | Nobody: Phase 3 shows the address only after the test email arrives | Phase 3 entry condition | Phase 3 manual check 2 |

## Consumer sweep

Command: `rg -n "generateNetwork|GeneratedPreview" src tests e2e tools` (2026-11-22). Results and coverage:

| Consumer | Covered by |
| --- | --- |
| `src/lib/generate/network.ts` | Phase 1 (adds `target`; default `"preview"`) |
| `src/lib/preview/artifacts.ts` | Unchanged call keeps the default; Phase 2 adds the bundle route beside it |
| `tests/generate/network.test.ts`, `tests/generate/oracle.test.ts`, `tests/generate/validate.test.ts` | Phase 1 (preview pin, bundle cases) |
| `tests/preview/artifacts.test.ts` | Phase 2 (unchanged cases must still pass) |
| `tools/release/required-tests.json` | Phases 1 to 3 add the new test names |

`CONTACT_URL` (`rg -n CONTACT_URL src`): `src/app/page.tsx:33` and `own-site.ts`; unchanged in meaning (bugs), Phase 3 adds `LEAD_EMAIL` beside it.

## Batch eligibility

Phase 1 has two independent units: the zip writer (`src/lib/bundle/zip.ts`, `tests/bundle/zip.test.ts`) and the file set (`src/lib/bundle/files.ts`, the `target` option, their tests) `[batch-eligible]`. Phase 2 and Phase 3 stay with one implementer because they share `AnalysisView.tsx` and the e2e suite. One integration owner merges locally into `develop`; no working branch is pushed and no pull request is opened.

## Coordination with the owner's UI pass

Juan is changing the UI on `develop` from 2026-11-22. Phase 2 and Phase 3 start by rebasing on the current `develop`, keep their UI in `InstallPanel.tsx` and one placement line, and re-run the phone-width and theme tests on top of his changes. Screenshots and the video wait for his signal (project memory).

## Risks

- `build_network.mjs` may encode the manifest in `bridge/action-bridge.html` in a way that is hard to reproduce in TypeScript. Phase 1 proves equality first; if it fails, the fallback is to precompute nothing and stop for an owner decision, since serving files that the oracle did not write would break the conformance claim.
- Zip size: the runtime is 3.9 MB raw. INFERRED from typical JavaScript compression: about 1 MB zipped. Criterion 8 measures it.
- A bundle downloaded for a site the visitor does not own could be hosted elsewhere. The files hold only public snapshot data, the README says "for a site you own", and the organizers' own skill offers the same companion build. Accepted by the owner's access decision.

## Handoff

- Objective and scope: above. Authorization: planning only. Implementation, the SES change, any push, deployment and release each need Juan's authorization for that action.
- Base: `develop` `d126b83`, clean, equal to `origin/develop`. Production `e9438c4`.
- Specification: `cognizant-ai-labs/agentic-web` HEAD `e34299792cb85f6eb27fed896fdedf65880b458b` (2026-11-22); differs from the vendored `05165377aca457381bd41b5c05e7a26cd23e6d74` only in `docs/agentic_websites.md` (GitHub compare API).
- Overlay: `.rpi/project/rpi-plan.md` is absent; no declared override applied.
- Next: owner acceptance of this plan, then `/rpi-implement` Phase 1 in a worktree from `develop`.
