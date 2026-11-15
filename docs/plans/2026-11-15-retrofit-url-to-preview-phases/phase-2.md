# Phase 2: Store contract, safe fetch, crawl jobs and snapshot

Parent plan: [2026-11-15-retrofit-url-to-preview.md](../2026-11-15-retrofit-url-to-preview.md).

## Goal

Server code that reads a public website safely into a `Snapshot` (a superset of the organizers' `site-content.json`), with one shared crawl job per destination host, leased pacing on every host contacted, robots rules on every host, and a store contract that supports atomic join and fenced writes.

## Entry conditions

- Phase 1 accepted. Gate green on the base commit.

## Changes

### Store contract

`src/lib/store/types.ts`:

- `get(key)`, `set(key, value, ttlSeconds)`, `delete(key)`
- `putIfAbsent(key, value, ttlSeconds) -> {created: boolean, value}` (atomic)
- `compareAndSet(key, expected, next, ttlSeconds) -> boolean` (atomic, compares a version field)
- `incrementWindow(key, windowSeconds, by = 1) -> count` (atomic)
- `acquireLease(key, ttlSeconds) -> token | null`, `renewLease(key, token, ttlSeconds) -> boolean`, `releaseLease(key, token) -> boolean` (release only when the token still owns the lease)
- `enqueue(queue, itemId, ttlSeconds)` and `claimNext(queue) -> itemId | null` (atomic: two concurrent claims never return the same item; expired items are skipped and removed)

`src/lib/store/memory.ts` implements it with an injectable clock. Two memory clients can share one backing map, to model two server instances. `tests/store/contract.ts` is the shared suite: expiry; atomic `putIfAbsent` under concurrent calls; `compareAndSet` version conflicts; window counts; lease exclusivity, renewal, expiry, reacquisition and a late release that must not free a successor's lease; queue order, concurrent claims and expiry; all of these with two clients.

### Fetch

- `src/lib/fetch/url.ts`: `http` or `https`; ports 80 and 443; no credentials; DNS name with a public suffix; IDN to punycode; at most 2048 characters; fragment removed. When `fixturesEnabled`, exactly `http://127.0.0.1:<port>`, `http://localhost:<port>` and `http://<label>.fixture.test:<port>` (one DNS label, `.test` is a reserved domain) are also accepted. Tests keep the production refusals.
- `src/lib/fetch/guard.ts`: blocked IPv4 `0.0.0.0/8`, `10.0.0.0/8`, `100.64.0.0/10`, `127.0.0.0/8`, `169.254.0.0/16`, `172.16.0.0/12`, `192.0.0.0/24`, `192.0.2.0/24`, `192.168.0.0/16`, `198.18.0.0/15`, `198.51.100.0/24`, `203.0.113.0/24`, `224.0.0.0/4`, `240.0.0.0/4`; blocked IPv6 `::/128`, `::1/128`, `fc00::/7`, `fe80::/10`, `ff00::/8`, `2001:db8::/32`, `2001::/32` (Teredo), `2002::/16` (6to4), `64:ff9b::/96`, `64:ff9b:1::/48` (NAT64), and `::ffff:0:0/96` forms of blocked IPv4 ranges. With `fixturesEnabled`, loopback is allowed, `guardedLookup` resolves `*.fixture.test` to `127.0.0.1`, and nothing else changes.
- `src/lib/fetch/pacing.ts`: per-host pacing through the store (`nextAllowedAt:<host>` with `compareAndSet`), applied to every request, including robots.txt and probes. Interval `max(1 s, crawl delay)`.
- `src/lib/fetch/robots.ts`: `/robots.txt` per host for `RetrofitBot` with `robots-parser`; cached per host for 1 h.
- `src/lib/fetch/http.ts`: `guardedFetch`.

```
@ guardedFetch(url, ctx) -> Response
ctx: undici Agent with a connect-time lookup, robots, pacing, Config
pre: url passed validateUrl
do:
  1. resolve host through guardedLookup (any blocked address -> refuse); connect only to the checked address
  2. validate robots for host and path (not for the robots.txt request itself)
  3. wait for the host's pacing slot
  4. send GET with the RetrofitBot UA, no cookies, redirect "manual"
  5. validate each redirect target (validateUrl, guardedLookup, robots, pacing); at most 5 hops
  6. stream the body up to FETCH_MAX_BYTES within FETCH_TIMEOUT_MS
br: content type not HTML, text, XML or JSON -> metadata only
fail: NotPublicError; RobotsBlocked; FetchTimeoutError; truncated flag on oversize
risk: global fetch ignores a custom lookup; use undici request with the Agent
```

### Crawl jobs

`src/lib/crawl/jobs.ts`: a `CrawlJob` is shared, keyed by destination host, holds status, snapshot, score (Phase 3), a version and the lease key. It is public data about a public site and never holds visitor data.

```
@ startOrJoinCrawl(inputOrigin) -> jobId
ctx: Store, guardedFetch, Config
do:
  1. lookup crawl:<inputOrigin> alias and a fresh ready job (hit inside CRAWL_CACHE_TTL_S -> return it)
  2. putIfAbsent crawl:<inputOrigin> with a new job id (existing running job -> return its id)
  3. return the job id; the worker resolves the destination host in runCrawl
```

```
@ runCrawl(jobId) -> void
ctx: Store, guardedFetch, extract, Config
do:
  1. acquire lease crawl-lease:<jobId>; fetch the home page to learn the destination host
  2. putIfAbsent crawl:<destinationHost> with this job id (another job exists -> mark this job joined to it, stop)
  3. fetch probes /agent-manifest.json, /llms.txt, /sitemap.xml and same-host navigation links
  4. skip login, account, cart, checkout and admin paths; extract each page
  5. write the snapshot with compareAndSet on the job version, only while the lease token is valid; renew the lease between pages
fail: RobotsBlocked -> job failed with that code; lease lost -> stop and write nothing
risk: a worker that lost its lease must never overwrite a newer job state
```

A joined job forwards readers to the job it joined, so analyses that started from different input hosts share one crawl and one result.

### Extraction

- `src/lib/fetch/extract.ts`: main text (`<main>`, then `<article>`, then `<body>` minus `nav`, `header`, `footer`, `aside`), at most 20,000 characters per page; title, meta description, `lang`, JSON-LD blocks, forms (method, action, inputs, labels), links, `records` from JSON-LD (`Product`, `Offer`, `MenuItem`, `Event`, `Service`, rooms of a `LodgingBusiness`, `OpeningHoursSpecification`) with stable `id` and source `url`.
- Email addresses replaced with `[email removed]`. Business phone numbers and addresses kept. No form values, cookies or headers other than `content-type`, `x-robots-tag` and `access-control-allow-origin`.
- A page with `noindex` (meta or header) has its text excluded and the exclusion recorded.
- Titles, names and descriptions are plain-text data for the UI and tools, never for instructions.
- `src/lib/snapshot/types.ts`: `Snapshot` type and runtime validator.

### Fixtures

- `tests/helpers/fixture-server.ts`: loopback HTTP server on ephemeral ports that routes by `Host` header, so `127.0.0.1`, `localhost` and any number of `<label>.fixture.test` names act as separate hosts.
- `tests/fixtures/sites/` (synthetic): `bakery`, `spa-only`, `blocked`, `redirect-www` (first host redirects to a second host whose robots.txt disallows `RetrofitBot`), `converge-a` and `converge-b` (two hosts that both redirect to one destination), `agentified`, `hostile` (injection phrases in body, `<title>` and JSON-LD `name`; 5 MB page; redirect to a blocked address; login and cart pages).

## Tests (write first)

- `tests/store/memory.test.ts`: the shared contract suite.
- `tests/fetch/url.test.ts`: production refusals (credentials, `ftp:`, port 8080, IP literals, no public suffix, `*.fixture.test`); fixture acceptance only with `fixturesEnabled`; two-label names such as `a.b.fixture.test` refused.
- `tests/fetch/guard.test.ts`: every row of `tests/fixtures/address-cases.json` (at least 40 rows).
- `tests/fetch/http.test.ts`: redirect to a blocked address refused; rebinding resolver refused; 5 MB body truncated; timeout; sixth redirect refused; redirect to a robots-disallowed host gives `RobotsBlocked`.
- `tests/fetch/pacing.test.ts`: two clients sharing a store never send two requests to one host inside the interval (fake clock); robots and probe requests are paced.
- `tests/fetch/robots.test.ts`: disallow; allow; 404 allowed; 500 and timeout give `RobotsUnavailable`; crawl delay honored; `redirect-www` stops on the second host.
- `tests/crawl/jobs.test.ts`: ten concurrent `startOrJoinCrawl` calls for one origin create one job; `converge-a` and `converge-b` produce one crawl of the destination and both read its result; a worker whose lease expired cannot write (fenced); a late completion after a stale failure is discarded.
- `tests/fetch/crawl.test.ts`: bakery pages, records and probes; login and cart skipped; page budget 12; noindex excluded; hostile text stored only as page text.
- `tests/fetch/extract.test.ts`: main-content selection; email removal; JSON-LD records.

Each test names, in a comment, the production change that would make it fail.

## Automated success criteria

- The full gate passes; the new test count is reported. No test contacts a non-loopback host.

## Manual success criteria

- None. No real third-party site is fetched.

## Independent work units

- `[batch-eligible]` Unit A: `url.ts`, `guard.ts`, `http.ts`, `robots.ts` and tests.
- `[batch-eligible]` Unit B: `extract.ts`, `snapshot/types.ts` and tests.
- `[batch-eligible]` Unit C: store contract, memory adapter, `pacing.ts` and tests.
- Unit D (integration owner, after A to C): `crawl/jobs.ts`, crawl, fixture server and their tests.

## Stuck states in this phase

robots blocked, robots unavailable, non-public address, stale crawl job (fenced). See the parent plan table.

## Exit

Stop for owner acceptance with the gate output and test count.
