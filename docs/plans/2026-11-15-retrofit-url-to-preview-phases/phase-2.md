# Phase 2: Safe fetch service and site snapshot

Parent plan: [2026-11-15-retrofit-url-to-preview.md](../2026-11-15-retrofit-url-to-preview.md).

## Goal

Server code that reads a public website safely and turns it into a `Snapshot`, a superset of the organizers' `site-content.json` (`references/live_url_mode.md`, step 2). It follows robots rules on every host it contacts, paces requests per host, limits size and time, refuses non-public addresses, caches results and treats all content as untrusted data.

## Entry conditions

- Phase 1 accepted. Gate green on the base commit.

## Changes

### Files

- `src/lib/store/types.ts`: the `Store` contract: `get`, `set(key, value, ttlSeconds)`, `delete`, `incrementWindow(key, windowSeconds) -> count`, `acquireLock(key, ttlSeconds) -> boolean`, `releaseLock(key)`.
- `src/lib/store/memory.ts`: in-memory implementation with an injectable clock.
- `tests/store/contract.ts`: shared contract suite for every adapter (expiry, window counts, lock exclusivity, lock expiry).
- `src/lib/fetch/url.ts`: normalize and validate the input URL: `http` or `https`; ports 80 and 443 only; no credentials in the URL; host must be a DNS name with a public suffix (IP literals refused); IDN converted to punycode; at most 2048 characters; fragment removed.
- `src/lib/fetch/guard.ts`: classify an IP address. Blocked: IPv4 `0.0.0.0/8`, `10.0.0.0/8`, `100.64.0.0/10`, `127.0.0.0/8`, `169.254.0.0/16`, `172.16.0.0/12`, `192.0.0.0/24`, `192.0.2.0/24`, `192.168.0.0/16`, `198.18.0.0/15`, `198.51.100.0/24`, `203.0.113.0/24`, `224.0.0.0/4`, `240.0.0.0/4`; IPv6 `::/128`, `::1/128`, `fc00::/7`, `fe80::/10`, `ff00::/8`, `2001:db8::/32`, Teredo `2001::/32`, 6to4 `2002::/16`, `64:ff9b::/96` and `64:ff9b:1::/48` (NAT64), and IPv4-mapped `::ffff:0:0/96` forms of blocked IPv4 ranges. When `fixturesEnabled`, loopback is allowed and nothing else changes.
- `src/lib/fetch/http.ts`: `guardedFetch`.
- `src/lib/fetch/robots.ts`: fetch and evaluate `/robots.txt` per host for user agent token `RetrofitBot`, with `robots-parser`. Results cached per host for 1 h.
- `src/lib/fetch/limits.ts`: host pacing and client quotas on the `Store`.
- `src/lib/fetch/cache.ts`: index from normalized origin to the latest ready record id, TTL `SNAPSHOT_CACHE_TTL_S`.
- `src/lib/fetch/crawl.ts`: `crawlSite`.
- `src/lib/fetch/extract.ts`: HTML to page text, title, meta description, `lang`, JSON-LD blocks, forms (method, action, inputs and labels), links and structured `records`.
- `src/lib/snapshot/types.ts`: `Snapshot` type and runtime validator.
- `tests/helpers/fixture-server.ts`: loopback HTTP server for synthetic sites; can serve two host names (`127.0.0.1` and `localhost`) to model apex and `www`.
- `tests/fixtures/sites/` (synthetic only):
  - `bakery`: plain HTML, JSON-LD `Bakery`, menu with prices, opening hours, contact form
  - `spa-only`: empty HTML shell rendered by JavaScript
  - `blocked`: robots.txt disallows `RetrofitBot`
  - `redirect-www`: the first host redirects to a second host whose robots.txt disallows `RetrofitBot`
  - `agentified`: publishes a valid `agent-manifest.json` and network
  - `hostile`: prompt-injection phrases in the body, in `<title>` and in the JSON-LD `name`; a 5 MB page; a redirect to a blocked address; a login page; a cart page

### User agent

`RetrofitBot/0.1 (+https://retrofit.thecreativetoken.com/bot)`. Phase 3 adds the `/bot` page.

### Pseudocode

```
@ guardedFetch(url, opts) -> Response
ctx: undici Agent with a custom connect lookup, robots, Config
pre: url passed validateUrl
do:
  1. resolve host through guardedLookup (rejects if any resolved address is blocked)
  2. connect only to the checked address (the lookup runs at connect time, so DNS rebinding is checked)
  3. validate robots for this host and path (skipped only for the robots.txt request itself)
  4. send GET with RetrofitBot UA, no cookies, redirect "manual"
  5. validate each redirect target with validateUrl, guardedLookup and robots for its host; at most 5 hops
  6. stream the body up to FETCH_MAX_BYTES; stop at FETCH_TIMEOUT_MS
br: content type not HTML, text, XML or JSON -> return metadata only
fail: blocked address -> NotPublicError; robots disallow -> RobotsBlocked; timeout -> FetchTimeoutError; too large -> truncated flag
risk: global fetch ignores a custom lookup; use undici request with the Agent
```

```
@ crawlSite(origin, clientId) -> Snapshot
ctx: Store, robots, limits, guardedFetch, extract, Config
pre: origin normalized
do:
  1. acquire host lock with HOST_LOCK_TTL_S (one crawl per host at a time)
  2. fetch the home page; the final host after redirects becomes the crawl host
  3. fetch the probe paths /agent-manifest.json, /llms.txt, /sitemap.xml on the crawl host
  4. fetch same-host navigation links in document order; skip login, account, cart, checkout, admin paths
  5. extract each page; write Snapshot with fetchedAt and partial flag
  6. release host lock
br: robots disallows "/" on the crawl host -> RobotsBlocked without fetching pages
br: CRAWL_MAX_PAGES or CRAWL_BUDGET_MS reached -> stop, mark snapshot partial
fx: outbound GETs paced at max(1 s, crawl delay) per host
fail: robots 5xx or timeout -> RobotsUnavailable (cached 1 h); lock held -> CrawlInProgress
```

Every fetch, including the declared network fetch in Phase 3, goes through `guardedFetch`, so robots rules apply on every host.

### Extraction rules

- Page text is the main content without navigation, header and footer (prefer `<main>`, then `<article>`, then `<body>` minus `nav`, `header`, `footer`, `aside`). At most 20,000 characters per page.
- Replace email addresses in stored text with `[email removed]`. Keep business phone numbers and addresses. Do not store form field values, cookies or response headers other than `content-type`, `x-robots-tag` and `access-control-allow-origin`.
- `records` come from JSON-LD: `Product`, `Offer`, `MenuItem`, `Event`, `Service`, rooms of a `LodgingBusiness`, `OpeningHoursSpecification`. Each record has a stable `id` (slug of the name, deduplicated) and a source `url`.
- A page with `<meta name="robots" content="noindex">` or `X-Robots-Tag: noindex` has its text excluded, and the exclusion is recorded.
- Titles, names and descriptions are stored as plain text only. They are data for the UI and tools, never for instructions.

## Tests (write first)

- `tests/fetch/url.test.ts`: accepted and refused inputs, including `http://user:pass@host`, `ftp:`, port 8080, IP literals, IDN hosts.
- `tests/fetch/guard.test.ts`: every row of `tests/fixtures/address-cases.json` (at least 40 rows: each blocked range above, IPv4-mapped forms, NAT64 forms, two public IPv4 and two public IPv6 addresses); loopback refused without `fixturesEnabled` and allowed with it.
- `tests/fetch/http.test.ts`: redirect to a blocked address refused; rebinding resolver (public at check, blocked at connect) refused; 5 MB body truncated with the flag; timeout raises `FetchTimeoutError`; a sixth redirect refused; a redirect to a host whose robots.txt disallows gives `RobotsBlocked`.
- `tests/fetch/robots.test.ts`: disallow for `RetrofitBot`; allow; 404 means allowed; 500 and timeout give `RobotsUnavailable`; crawl delay honored; `redirect-www` stops on the second host.
- `tests/fetch/limits.test.ts`: per-host pacing with a fake clock; per-client window.
- `tests/fetch/cache.test.ts`: index hit inside the TTL, miss after.
- `tests/fetch/crawl.test.ts`: bakery gives the expected pages, records and probes; login and cart pages skipped; the page budget stops at 12; a noindex page is excluded; the host lock expires after `HOST_LOCK_TTL_S` with a fake clock; hostile text is stored only as page text.
- `tests/fetch/extract.test.ts`: main-content selection; email removal; JSON-LD records with ids and URLs.
- `tests/store/memory.test.ts`: the shared contract suite.

Each test names, in a comment above its assertions, the production change that would make it fail.

## Automated success criteria

- The full gate passes; the new test count is reported.
- No test contacts a non-loopback host. The fixture server binds loopback on ephemeral ports.

## Manual success criteria

- None. No real third-party site is fetched in this phase.

## Independent work units

- `[batch-eligible]` Unit A: `url.ts`, `guard.ts`, `http.ts`, `robots.ts` and their tests.
- `[batch-eligible]` Unit B: `extract.ts`, `snapshot/types.ts` and their tests (fixture HTML strings).
- `[batch-eligible]` Unit C: `store/*`, `limits.ts`, `cache.ts` and their tests.
- Unit D (integration owner, after A, B and C): `crawl.ts`, fixture server, crawl tests.

## Stuck states in this phase

robots blocked, robots unavailable, non-public address, crawl in progress. See the parent plan table. In Phase 3, `CrawlInProgress` returns the running analysis id, so the visitor waits on the same result.

## Exit

Stop for owner acceptance with the gate output and the test count.
