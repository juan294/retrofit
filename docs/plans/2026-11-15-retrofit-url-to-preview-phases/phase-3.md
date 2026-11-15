# Phase 3: Score tool contract, deterministic score, analysis flow and pages

Parent plan: [2026-11-15-retrofit-url-to-preview.md](../2026-11-15-retrofit-url-to-preview.md).

## Goal

A visitor pastes a URL on the landing page, sees progress, and gets a deterministic agent-readiness score with a check-by-check breakdown. Agents get the same score from `GET /api/score?url=`. No LLM is used.

## Entry conditions

- Phase 2 accepted.
- Run `rpi-tool-design` for the agent-facing score surface (the `/api/score` response and the `score_site` site action of Phase 4), as `AGENTS.md` requires before agent-facing tools are defined. Save its contract and seed evaluations to `docs/research/score-tool-contract.md`, with the run date in its header. Where its contract differs from this phase file, the contract wins, and the difference is recorded in the phase handoff.

## Score version `score/v1`

Each check returns `pass`, `fail` or `not-checked`, with evidence (the URL and the fact found). The score is the sum of the weights of passed checks divided by the sum of the weights of checked checks, times 100, rounded down. With fewer than 3 checked checks there is no score, only the results.

| Group | Check id | Rule | Weight |
| --- | --- | --- | --- |
| Agentic web | `aw.manifest` | `/agent-manifest.json` returns JSON with at least one network with `name`, `front_man` and `hocon` | 15 |
| Agentic web | `aw.network-valid` | The declared network loads through `guardedFetch` and passes the vendored `validateNetwork` | 10 |
| Agentic web | `aw.cors` | The manifest response has an `Access-Control-Allow-Origin` that permits other origins | 5 |
| Discoverability | `disc.robots-agents` | robots.txt does not disallow `/` for any of `GPTBot`, `ClaudeBot`, `PerplexityBot`, `Google-Extended`, `RetrofitBot` | 8 |
| Discoverability | `disc.sitemap` | A sitemap is declared in robots.txt or `/sitemap.xml` returns XML | 4 |
| Discoverability | `disc.llms-txt` | `/llms.txt` returns text | 4 |
| Readable content | `read.server-text` | The home page HTML has at least 200 characters of main text without running JavaScript | 12 |
| Readable content | `read.title-description` | Title and meta description on the home page | 4 |
| Readable content | `read.lang` | `<html lang>` present | 2 |
| Structured data | `data.jsonld` | At least one valid JSON-LD block | 8 |
| Structured data | `data.business` | JSON-LD `Organization` or `LocalBusiness` subtype with a name and an address or URL | 6 |
| Structured data | `data.offers` | JSON-LD `Product`, `Offer`, `MenuItem`, `Event` or `Service` present | 6 |
| Structured data | `data.hours` | `OpeningHoursSpecification` present (`not-checked` without a `LocalBusiness`) | 3 |
| Actionability | `act.form-labels` | Every visible input in fetched forms has a label or `aria-label` (`not-checked` without forms) | 5 |
| Actionability | `act.task-links` | The home page links to a task page (contact, book, order, reserve, buy, menu) | 4 |
| Security | `sec.https` | The final URL uses HTTPS | 4 |

Weights total 100. WebMCP tools cannot be detected without running page scripts, so the report says "WebMCP: not checked". Any change to a rule or weight requires a new score version.

## Changes

- `src/lib/score/checks.ts`: one pure function per check over the `Snapshot` and its probe results.
- `src/lib/score/score.ts`: `scoreSnapshot(snapshot) -> ScoreReport` with version, total, groups and per-check evidence.
- `src/lib/analysis/record.ts`: `AnalysisRecord` with `id` (128-bit random, base64url), `origin`, `status` (`queued`, `crawling`, `scoring`, `ready`, `failed`, `expired`), `failure` (code and visitor text), `score`, `snapshot` (stored with the record), `createdAt`, `updatedAt`, `expiresAt` (`RECORD_TTL_S`), `clientHash`.
- `src/lib/analysis/run.ts`:

```
@ startAnalysis(rawUrl, clientId) -> {id, status}
ctx: Store, limits, cache, crawlSite, scoreSnapshot, waitUntil
pre: request from the landing form, the score API or score_site
do:
  1. validate URL (NotPublicError -> 400 with visitor text)
  2. lookup cache index for the origin (hit inside SNAPSHOT_CACHE_TTL_S -> return that id)
  3. increment client window (over ANALYSES_PER_CLIENT_HOUR -> 429 with retry time)
  4. write record status queued
  5. emit background job via waitUntil: crawl -> score -> write ready with snapshot -> update cache index
br: crawlSite returns CrawlInProgress -> return the running record id
fail: crawl error -> record failed with code and visitor text
```

- `clientId` is a SHA-256 of the client IP and a daily salt derived from `SESSION_SECRET`. The raw IP is never stored or logged.
- `src/app/api/analyze/route.ts` (`POST {url}`, same-origin only: `Sec-Fetch-Site` is `same-origin` or `Origin` equals `PUBLIC_ORIGIN`).
- `src/app/api/analyze/[id]/route.ts` (`GET`): marks a non-final record failed when `updatedAt` is older than `STALE_AFTER_S`; returns `expired` after `expiresAt`.
- `src/app/api/score/route.ts` (`GET ?url=`, open to agents, `Access-Control-Allow-Origin: *`, no cookies): starts or reuses an analysis, waits up to 50 s for `ready`, else returns 202 with `{"status": "running", "retryAfterSeconds": 20, "message": "The score is still running. Call again in 20 seconds with the same URL."}`. Uses the same client limit. `maxDuration` 60 s for these routes.
- `src/app/page.tsx`: labelled URL form, API messages, a line about what Retrofit reads and a link to `/bot`.
- `src/app/r/[id]/page.tsx`: polls every 1.5 s, shows status steps, then the score with groups and evidence; `noindex`; failure and expiry states show their visitor text and a button.
- `src/app/bot/page.tsx`: what `RetrofitBot` reads, its limits, and how to block it in robots.txt.

## Tests (write first)

- `tests/score/score.test.ts`: every fixture site against `tests/fixtures/expected-scores.json` (exact total and every check result). `agentified` passes the three agentic-web checks; `spa-only` fails `read.server-text`; `bakery` passes the structured-data checks.
- `tests/score/checks.test.ts`: a passing and a failing input per check.
- `tests/analysis/run.test.ts`: cache reuse; `CrawlInProgress` returns the running id; failure codes map to visitor text; client limit returns 429 with the retry time.
- `tests/analysis/stale.test.ts`: a `crawling` record with `updatedAt` 91 s ago is marked failed on read, one at 89 s is not; Retry after the stale failure starts a new crawl because the 60 s host lock has expired (fake clock).
- `tests/analysis/expiry.test.ts`: at `expiresAt` plus 1 s the record reads as `expired` and the results page shows the expiry text.
- `tests/api/analyze.test.ts`: route handlers with the memory store and the fixture server; a cross-origin `POST` is refused with 403.
- `tests/api/score.test.ts`: ready report; 202 body as above; open CORS header present; no `Set-Cookie`.
- `e2e/analyze.spec.ts`: paste the bakery fixture URL, see progress, then the score and evidence rows.
- `e2e/analyze-blocked.spec.ts`: the blocked fixture shows the robots message and no score.

## Automated success criteria

- The full gate passes; the golden score file matches exactly.

## Manual success criteria

- The owner reviews the check list and weights on the results page for the bakery fixture and accepts `score/v1`.
- The tool contract from `rpi-tool-design` is saved and its differences are recorded.

## Independent work units

- `[batch-eligible]` Unit A: `src/lib/score/*` and score tests.
- `[batch-eligible]` Unit B: `src/lib/analysis/*`, API routes and their tests.
- Unit C (integration owner, after A and B): pages and e2e specs.

## Stuck states in this phase

Stale analysis, robots blocked, client limit, preview expired, score still running. See the parent plan table.

## Exit

Stop for owner acceptance.
