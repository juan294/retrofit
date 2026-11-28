# Changelog

All notable changes to Retrofit are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.3.0] - 2026-11-28

### Added

- `/pricing` with "notify me", `/privacy` and `/terms`, and unsubscribe.
- Accounts: sign-in by email link (no password), saved reports, sign-out and account deletion. A link opened in another browser names its address before it signs in.
- Ownership claims by meta tag or DNS record, rechecked daily.
- Publishing: the verified owner of a site can publish its report and agent at `/s/<host>`, and embed a badge. A verified owner gets a new read of the site an hour after the last one.
- Billing in Stripe test mode, plans, a free-analysis limit and API keys. All of it starts only at `BILLING_START` (2027-01-20T00:00:00Z); before that Retrofit stays open and free. Signed-in Free accounts keep the free AI.
- Navigation to the plans and the account on every page.
- `/api/health` names the account data, and the production evidence checks it and sends a sign-in email.
- The Field Inspection look, first part: new colours, the Archivo and IBM Plex Mono fonts served from Retrofit's own origin, one page shell and footer, and one notice pattern.

### Changed

- Judge access lasts through judging after one entry of the code, with daily call limits per session (200) and per network (1,000).
- The preview agent shows Retrofit line icons in place of the runtime's emoji.
- A production build with a missing or malformed variable fails instead of taking the site down.
- Every per-network limit counts an IPv6 /64 as one network.

### Fixed

- The judge form and the address form no longer submit before the page is ready.
- A failing step of the daily cleanup no longer stops the others; failures reach the owner.

### Known issues

- S3: a partner site that calls a published agent gets no tools (AS-M1).
- S3: the new public pages have no shared cache, rate limit or performance budget (PE-M1).
- S3: a notify signup keeps the first caller's consent; a later signup or re-subscribe reports success without an effect (BE-L3). No notice email is sent yet.
- S4: no gate step has a time limit, so a hung local test run stops nothing (QA-L1).
- The Field Inspection look covers the shared shell, the fonts and the colours; the report, the agent panel and the account pages get the full design in later releases.

## [0.2.0] - 2026-11-22

### Added

- Analysis owners can download a ZIP with the browser assistant, saved public pages and hosting instructions. After installation, visitors can ask questions on the site's own `/assistant/` page using their chosen AI provider.
- The results and home pages offer installation help by email. Inquiries from a result include the site and its score.
- Partner sites that call `retrofit_guide` can score a site: Retrofit's action bridge now shares the read action `score_site` with every caller origin.

### Fixed

- `/judges` names the key panel by its on-page label instead of the hidden AI settings.

## [0.1.0] - 2026-11-20

First public release, live at https://retrofit.thecreativetoken.com.

### Added

- Site score (`score/v1`): 16 checks, 100 points, in six areas (agentic web 30, structured data 23, readable content 18, discoverability 16, actionability 9, security 4).
- Private preview agent: an agent network generated from the site and run in the browser with the organizers' agentic-web runtime, labelled unofficial.
- Free model path: a server proxy to Otari with a worst-case cost reservation per request, separate capped keys for the public and judge pools, session and visitor limits, an overrun hold and a daily credit check.
- Bring your own key for Otari, Google AI Studio, Groq, OpenAI, Anthropic and OpenRouter; the key stays in the browser.
- Retrofit's own `agent-manifest.json`, in-browser agent network, consent before contacting another site, and a conformance page with the demo partner site `demo-harbor.thecreativetoken.com`.
- Judge access at `/judges` until 2027-01-18.
- Safe third-party fetching: robots rules, caching, per-site pacing and an SSRF guard.

### Known issues

- S3: a visitor's EU Otari key is sent to Otari's US host and gets HTTP 421; the free path is not affected.
- S4: some vendored runtime text is below WCAG AA contrast; the runtime's action review dialog is untested in dark mode.

[0.3.0]: https://github.com/juan294/retrofit/releases/tag/v0.3.0
[0.2.0]: https://github.com/juan294/retrofit/releases/tag/v0.2.0
[0.1.0]: https://github.com/juan294/retrofit/releases/tag/v0.1.0
