# Changelog

All notable changes to Retrofit are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Unreleased

### Added

- Analysis owners can download a ZIP with the browser assistant, saved public pages and hosting instructions. After installation, visitors can ask questions on the site's own `/assistant/` page using their chosen AI provider.
- The results and home pages offer installation help by email. Inquiries from a result include the site and its score.

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

[0.1.0]: https://github.com/juan294/retrofit/releases/tag/v0.1.0
