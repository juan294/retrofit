# Phase 3: Score tool contract, deterministic score, visitor-owned analyses, pages and budgets

Parent plan: [2026-11-15-retrofit-url-to-preview.md](../2026-11-15-retrofit-url-to-preview.md).

## Goal

A visitor pastes a URL, sees progress and gets a deterministic agent-readiness score with evidence. The visitor's analysis is private to their browser. Agents get the public score from `GET /api/score?url=`. Status traffic and crawl work have measured budgets. No LLM is used.

## Entry conditions

- Phase 2 accepted.
- Run `rpi-tool-design` for the agent-facing score surface (`/api/score` and the Phase 4 `score_site` action), as `AGENTS.md` requires. Save the contract and seed evaluations to `docs/research/score-tool-contract.md` with the run date in its header. Where the contract differs from this file, the contract wins and the difference is recorded in the phase handoff.

## Score version `score/v1`

Each check returns `pass`, `fail` or `not-checked` with evidence. Score = weights of passed checks / weights of checked checks x 100, rounded down; fewer than 3 checked checks gives no score.

| Group | Check id | Rule | Weight |
| --- | --- | --- | --- |
| Agentic web | `aw.manifest` | `/agent-manifest.json` returns JSON with a network that has `name`, `front_man` and `hocon` | 15 |
| Agentic web | `aw.network-valid` | The declared network loads through `guardedFetch` and passes `validateNetwork` | 10 |
| Agentic web | `aw.cors` | The manifest response permits other origins | 5 |
| Discoverability | `disc.robots-agents` | robots.txt does not disallow `/` for `GPTBot`, `ClaudeBot`, `PerplexityBot`, `Google-Extended` or `RetrofitBot` | 8 |
| Discoverability | `disc.sitemap` | Sitemap declared in robots.txt or `/sitemap.xml` returns XML | 4 |
| Discoverability | `disc.llms-txt` | `/llms.txt` returns text | 4 |
| Readable content | `read.server-text` | Home page HTML has at least 200 characters of main text without JavaScript | 12 |
| Readable content | `read.title-description` | Title and meta description on the home page | 4 |
| Readable content | `read.lang` | `<html lang>` present | 2 |
| Structured data | `data.jsonld` | At least one valid JSON-LD block | 8 |
| Structured data | `data.business` | `Organization` or `LocalBusiness` subtype with a name and an address or URL | 6 |
| Structured data | `data.offers` | `Product`, `Offer`, `MenuItem`, `Event` or `Service` present | 6 |
| Structured data | `data.hours` | `OpeningHoursSpecification` present (`not-checked` without `LocalBusiness`) | 3 |
| Actionability | `act.form-labels` | Every visible input in fetched forms has a label or `aria-label` (`not-checked` without forms) | 5 |
| Actionability | `act.task-links` | Home page links to a task page (contact, book, order, reserve, buy, menu) | 4 |
| Security | `sec.https` | Final URL uses HTTPS | 4 |

Weights total 100. The report says "WebMCP: not checked". Any rule or weight change needs a new score version.

## Changes

### Score

- `src/lib/score/checks.ts`: one pure function per check over the snapshot and probes.
- `src/lib/score/score.ts`: `scoreSnapshot(snapshot) -> ScoreReport`; the crawl worker stores it on the `CrawlJob`.

### Visitor-owned analyses

- `src/lib/analysis/visitor.ts`: cookie `retrofit_visitor` (128-bit random, `HttpOnly`, `Secure` on HTTPS, `SameSite=Lax`, `Path=/`, `Max-Age` 30 days). The store keeps only its SHA-256.
- `src/lib/analysis/record.ts`: `Analysis` with `id` (128-bit random), `ownerHash`, `jobId`, `status` (from the job, plus `expired`), `createdAt`, `expiresAt` (`ANALYSIS_TTL_S`). When the job is ready, the analysis copies the snapshot and score it needs (so the preview survives the 24 h crawl cache).
- `src/lib/analysis/run.ts`:

```
@ startAnalysis(rawUrl, visitor, clientId) -> {id}
ctx: Store, startOrJoinCrawl, limits, waitUntil
pre: same-origin request (Sec-Fetch-Site same-origin or Origin equals PUBLIC_ORIGIN)
do:
  1. validate URL (NotPublicError -> 400 with visitor text)
  2. increment client window (over ANALYSES_PER_CLIENT_HOUR -> 429 with retry time)
  3. startOrJoinCrawl (capacity full -> job queued; daily host cap reached -> 429 with text)
  4. write a new Analysis owned by the visitor, linked to the job
  5. emit runCrawl via waitUntil when this call created the job
fx: Store writes
```

- Every analysis is new and owned by its visitor; only the crawl work is shared.
- `clientId` is a SHA-256 of the client IP and a daily salt from `SESSION_SECRET`; the raw IP is never stored or logged.
- Capacity: a running-crawl counter with leases (at most `CRAWL_MAX_CONCURRENT`); extra jobs wait in `queued` and start when a slot frees (checked by the status route, which schedules the next job with `waitUntil`); a daily destination-host counter (`CRAWL_MAX_HOSTS_PER_DAY`).

### Routes

- `POST /api/analyze` (`{url}`): same-origin only; sets the visitor cookie if absent; returns `{id}`.
- `GET /api/analyze/[id]`: requires the visitor cookie hash to equal `ownerHash`, else 404 with the "belongs to another browser" text (the same text for a nonexistent id). One store read for the analysis and one for its job. Response at most 2 KB: `{status, step, failure?, scoreReady}`. Marks a job failed when its lease has expired and `updatedAt` is older than `STALE_AFTER_S`.
- `GET /api/score?url=`: open to agents (`Access-Control-Allow-Origin: *`, no cookies read or set). Starts or joins a crawl job (client limit applies), waits up to `SCORE_WAIT_MS`, then returns the `ScoreReport` or 202 `{"status": "running", "retryAfterSeconds": 20, "message": "The score is still running. Call again in 20 seconds with the same URL."}`. It never returns analysis ids or preview paths.
- `maxDuration` 60 s for these routes.

### Pages

- `src/app/page.tsx`: labelled URL form, API messages, what Retrofit reads, link to `/bot`.
- `src/app/r/[id]/page.tsx`: server checks the visitor cookie (404 page otherwise); client polls every 1 s for 10 s, then every 2 s until 30 s, then every 5 s; stops at a final status and while the tab is hidden; shows steps, then the score with evidence; `noindex`; failure, expiry and capacity texts with buttons.
- `src/app/bot/page.tsx`: what `RetrofitBot` reads, its limits, and how to block it.

## Tests (write first)

- `tests/score/score.test.ts`: every fixture site against `tests/fixtures/expected-scores.json` (exact total and every check).
- `tests/score/checks.test.ts`: a passing and a failing input per check.
- `tests/analysis/run.test.ts`: two visitors analyzing one URL get different analysis ids and one shared job; client limit returns 429 with the retry time; failure codes map to visitor text.
- `tests/analysis/capacity.test.ts`: the ninth concurrent job waits in `queued` and starts when a slot frees; the daily host cap returns its text.
- `tests/analysis/stale.test.ts`: a job with an expired lease and `updatedAt` 91 s old is marked failed on read; at 89 s it is not; Retry starts a new job; the old worker's late write is discarded.
- `tests/analysis/expiry.test.ts`: at `expiresAt` + 1 s the analysis reads as `expired`; its preview data remains readable until then even after the 24 h crawl cache expires.
- `tests/api/analyze.test.ts`: cross-origin `POST` refused with 403; status for another visitor's id returns the 404 text; status response under 2 KB.
- `tests/api/score.test.ts`: report; 202 body; CORS header; no `Set-Cookie`; no analysis id in any response.
- `tests/perf/analyze-load.test.ts` (against `next start` with the fixture server): 10 concurrent analyses of distinct fixture hosts and 20 viewers polling one analysis; the job for the shared host crawls once; each status request makes at most 2 store reads (instrumented memory store); p95 status latency under 250 ms locally. The measured numbers go in the phase handoff.
- `e2e/analyze.spec.ts`: paste the bakery fixture URL, see progress, then the score and evidence.
- `e2e/analyze-blocked.spec.ts`: robots message, no score.
- `e2e/privacy.spec.ts` (part 1): two browser contexts analyze the same URL; each sees only its own `/r/<id>`; context B opening context A's `/r/<id>` gets the "belongs to another browser" page.

## Automated success criteria

- The full gate passes; the golden score file matches exactly; the load test passes its budgets.

## Manual success criteria

- The owner reviews the check list and weights on the bakery results page and accepts `score/v1`.
- The tool contract is saved and its differences are recorded.

## Independent work units

- `[batch-eligible]` Unit A: `src/lib/score/*` and score tests.
- `[batch-eligible]` Unit B: `src/lib/analysis/*`, routes and their tests.
- Unit C (integration owner, after A and B): pages, load test, e2e specs.

## Stuck states in this phase

Stale job, robots blocked, client limit, capacity full, expired analysis, visitor mismatch, score still running. See the parent plan table.

## Exit

Stop for owner acceptance.
