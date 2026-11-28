# Phase 6: Free inference with spend control, judge reserve and credit alert

Parent plan: [2026-11-15-retrofit-url-to-preview.md](../2026-11-15-retrofit-url-to-preview.md).

## Goal

A visitor or judge without a key can use the preview and Retrofit's own agent. The runtime sends the placeholder key `retrofit-free` to Retrofit's same-origin endpoint `/api/inference/v1` as an explicit router override. The credential is an HttpOnly session cookie. Every forwarded request is bounded, and a conservative bound on its cost, which depends on the provider assumptions in the parent plan ("Spend control"), is reserved against a ledger before it reaches Otari. Responses are buffered, so every failure reaches the unchanged runtime as an HTTP error (parent plan, fact 18). Public spend caps protect the judge reserve; a detected overrun holds the public pool until the owner reconciles. The owner is alerted when credit runs low and accepts the reserve guarantee level before this phase is accepted. A visitor's own key never reaches this endpoint.

## Entry conditions

- Phase 5 accepted.
- Owner authorization to use the Otari account and its credits. The owner creates an Otari API key in the dashboard (no CLI exists for it) and places it in the ignored `.env` as `OTARI_API_KEY`.
- Check, with that key, whether Otari offers a per-key spending limit or a balance or usage API, and record the result.
  - If per-key limits exist: the owner creates two keys, `OTARI_API_KEY_PUBLIC` limited to the credit minus the judge reserve and `OTARI_API_KEY_JUDGE`; the proxy uses the key of the session's pool. This is provider-backed isolation.
  - If not: one key serves both pools, and the guarantee is qualified (parent plan, "Spend control"). The phase handoff states it in those words.
- Read the price per million input and output tokens for `alibaba/qwen3.8-flash` from `GET https://api.otari.ai/api/v1/models` and record it, together with any per-request fee or minimum charge the listing shows (added to the reservation if present).
- The owner provides the credit balance and the judge reserve, and generates `JUDGE_CODE`.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `FREE_MODEL` | `alibaba/qwen3.8-flash` | Only model accepted |
| `FREE_PRICE_IN_PER_M`, `FREE_PRICE_OUT_PER_M` | required | USD per million tokens, from the Otari model list |
| `FREE_CREDIT_USD` | required | Credit available when the free path goes live, set by the owner from the Otari balance |
| `JUDGE_RESERVE_USD` | required | Part of the credit that only judge sessions may spend |
| `FREE_SERVICE_END` | `2027-01-18T23:59:59Z` | End of the free period for the daily budget calculation |
| `FREE_MAX_TOKENS` | 1024 | Output tokens per request, set by the server |
| `FREE_MAX_BODY_BYTES` | 98304 | Request body limit |
| `FREE_FRAMING_TOKENS_PER_MESSAGE` | 16 | Framing allowance per message in the reservation bound |
| `FREE_FRAMING_TOKENS_BASE` | 512 | Fixed framing allowance per request (system template, tool wrapper) |
| `FREE_MAX_MESSAGES` | 80 | Messages per request |
| `FREE_MAX_TOOLS` | 16 | Tools per request; each tool definition at most 4096 bytes |
| `FREE_INFLIGHT_PER_SESSION` | 2 | Concurrent requests per session |
| `FREE_INFLIGHT_GLOBAL` | 16 | Concurrent requests overall |
| `FREE_CALLS_PER_SESSION` | 40 | Public session calls |
| `FREE_SESSIONS_PER_CLIENT_HOUR` | 6 | New sessions per client per hour |
| `JUDGE_CALLS_PER_SESSION_DAY` | 200 | Judge calls per session and UTC day (since 2026-11-25; `JUDGE_CALLS_PER_SESSION` is no longer read) |
| `JUDGE_CALLS_PER_CLIENT_DAY` | 1000 | Judge calls of all judge sessions of one network and UTC day |
| `JUDGE_SESSIONS_PER_CLIENT_DAY` | 20 | New judge sessions per network and UTC day |
| `FREE_UPSTREAM_TIMEOUT_MS` | 45000 | Upstream timeout (15 s margin inside `maxDuration` 60 s) |
| `CREDIT_ALERT_THRESHOLDS` | `0.5,0.8,0.95` | Fractions of the ledger that raise an alert |
| `ALERT_GITHUB_TOKEN` | required on Vercel | Fine-grained token with Issues write on `juan294/retrofit` only |

Add them to `src/lib/config.ts` with tests.

## Changes

### Sessions

- `src/lib/inference/token.ts`: HMAC-SHA-256 with `SESSION_SECRET`; `SessionClaims`: `sid`, `iat`, `exp` (2 h), `client`, `pool` (`public` or `judge`).
- `src/app/api/inference/session/route.ts` (`POST`, same-origin only): with no valid cookie, applies the per-client cap and creates a session; with a valid cookie, renews it with the same `sid`, `pool` and counters. Cookie `retrofit_session`: `HttpOnly`, `Secure` on HTTPS, `SameSite=Strict`, `Path=/api/inference`, `Max-Age` 7200. Renewal lives under `/api/inference` so that the browser sends the cookie to it.
- `src/app/judges/page.tsx` and `POST /api/inference/session/judge`: a correct code (constant-time compare, never logged) opens a judge session with a new session id (changed 2026-11-25; before, the current session became a judge session).

### Ledger and quotas

- `src/lib/inference/ledger.ts`: spend in micro-USD per UTC day and pool, a running total, and the sum of outstanding reservations.
  - Public daily budget = `max(0, FREE_CREDIT_USD - JUDGE_RESERVE_USD - publicSpentTotal - publicOutstanding) / daysLeft(FREE_SERVICE_END)`, computed at the start of each UTC day.
  - Judge budget = `min(JUDGE_RESERVE_USD - judgeSpentTotal, FREE_CREDIT_USD - totalSpent - totalOutstanding)`, so it reflects the remaining credit, including any overrun.
- `src/lib/inference/hold.ts`: a persistent record `inference:hold` (no TTL) with reason, time, the overrun amount and the request's reservation. While it exists, the public pool refuses new requests. Only `pnpm ops:resume-free --reconciled-balance <usd> --note <text>` removes it.
- `tools/ops/resume-free.mjs`: prints the ledger total, outstanding reservations, the hold record and the bound parameters; requires the owner's entered provider balance; refuses to resume when the entered balance is below the ledger's remaining credit; writes an audit record. Run against production only as an authorized action.
- `src/lib/inference/quota.ts`: session calls, client sessions, in-flight counters (per session and global, with leases so a crashed request frees its slot after 60 s).

### Request schema

`src/lib/inference/schema.ts` accepts only:

- top level `{model, messages, tools?, tool_choice?, stream?, temperature?, top_p?}`; any other field (including `n`, `logprobs`, `response_format`, `stream_options`) is refused
- `messages[]`: `role` in `system`, `user`, `assistant`, `tool`; `content` a string or `null` (no arrays, so no images, audio or file parts); `assistant` `tool_calls[]` with `id`, `type: "function"`, `function.name`, `function.arguments` (string); `tool` messages with `tool_call_id` and `name` (the runtime sends it, `runtime/runner.js:585`; it must match `^[A-Za-z0-9_]{1,64}$` and a tool name from an earlier `tool_calls` entry in the same request); no other keys
- The schema's acceptance list is tested against the bodies captured from the vendored runtime in Phase 4 (`tests/fixtures/runtime-requests/`), so a runtime field it rejects fails the gate.
- `tools[]`: `type: "function"` with `function.name`, `function.description`, `function.parameters` (a JSON object); at most `FREE_MAX_TOOLS`, each at most 4096 bytes serialized
- `tool_choice`: `"auto"` or `"none"`

### Reservation bound

```
@ reservationFor(body) -> micro-USD
pre: body passed the schema; serialized as UTF-8 bytes B
do:
  1. compute input token bound = B + FREE_FRAMING_TOKENS_PER_MESSAGE x messages + FREE_FRAMING_TOKENS_BASE
  2. compute output token bound = FREE_MAX_TOKENS
  3. compute charge = input bound x input price + output bound x output price + any per-request fee
risk: assumes a byte-level tokenizer (each billed input token covers at least one byte of the serialized request); the contract probe tests it
```

The serialized request bytes include every string the provider can tokenize (content, tool names, descriptions, schemas, arguments), so the bound holds for any text under that assumption, including high-density text where each byte becomes one token.

### Proxy

```
@ proxyChat(request) -> SSE body
ctx: token, quota, ledger, Store, Otari (server key), Config
pre: Authorization is "Bearer retrofit-free"
do:
  1. validate same origin (Sec-Fetch-Site same-origin or Origin equals PUBLIC_ORIGIN) and the retrofit_session cookie
  2. validate the body with the schema and size limits
  3. acquire in-flight slots; reserve reservationFor(body) atomically against the session, the pool and the ledger
  4. write upstream body: validated fields, model FREE_MODEL, n 1, stream true, stream_options.include_usage true, max_tokens FREE_MAX_TOKENS
  5. read the whole upstream stream within FREE_UPSTREAM_TIMEOUT_MS; require a finish_reason and a usage object
  6. reconcile: record the reported usage; return the buffered events as one SSE body with status 200
br: unknown field, wrong model or oversize -> 400 with text; any other Bearer -> 401, nothing forwarded
fx: counters, reservation, ledger; one upstream POST
fail: counters unavailable -> 503 before any upstream call; upstream error, timeout, incomplete stream or missing finish_reason -> 502 with recovery text, nothing of the partial answer returned
risk: reported usage above the reservation -> record the actual usage, write the persistent hold, open the overrun alert
```

- Because nothing reaches the browser until the upstream response is complete, a failure at any point is an HTTP 502, which the unchanged runtime shows as an error (`runtime/llm.js:128-131`).
- Missing usage keeps the full reservation, which is an upper bound under the stated assumption.
- A visitor disconnect aborts the upstream request; the reservation is kept, because the provider may already charge for it.
- Reconciliation never lowers the ledger below the reported usage, and never treats spend as undone.

- Error bodies use the OpenAI error shape so the runtime shows them in chat.
- `src/app/api/inference/v1/models/route.ts`: lists only `FREE_MODEL`.
- `src/app/api/inference/status/route.ts`: `{available, pool, reason}` without amounts.
- Logging: one redaction helper removes `authorization`, `cookie`, `set-cookie` and any value with a prefix from `providers.ts`.

### Credit alert

- `src/lib/ops/alert.ts`: opens one GitHub issue per alert key (threshold, judge reserve low, reservation overrun) and records the key so it does not repeat. The proxy calls it at once for an overrun.
- `src/app/api/cron/credit-check/route.ts`: daily (Vercel Cron in Phase 7), `Authorization: Bearer <CRON_SECRET>`. Compares the ledger total with `FREE_CREDIT_USD`. When a threshold is first crossed, or the judge reserve is below 25%, it opens one GitHub issue in `juan294/retrofit` titled "Free AI credit threshold reached" with the percentage and pool only (no amounts per visitor, no keys). It records the threshold so it does not repeat.

### Client

- `Preview.tsx` and the landing assistant: with no visitor key, `POST /api/inference/session`, then boot with `router` `${location.origin}/api/inference/v1`, `byokKey` `retrofit-free`, `model` `FREE_MODEL`. Renew every 30 min and on `visibilitychange`. The fetch guard allows the router origin (same origin). When the visitor connects a key, reboot with the provider router. The key panel shows "Using Retrofit's free AI" and "Use your own key".

## Tests (write first)

- `tests/inference/token.test.ts`: valid, tampered, expired, wrong secret.
- `tests/inference/session.test.ts`: renewal with a valid cookie keeps `sid`, `pool` and counters; the per-client cap applies only to new sessions; judge upgrade with a wrong code fails.
- `tests/inference/schema.test.ts`: array content, image parts, unknown roles, extra keys in messages, tool calls or tools, oversized tools and every refused top-level field are rejected; a tool message `name` that is malformed or matches no earlier tool call is rejected; every body in `tests/fixtures/runtime-requests/` is accepted.
- `tests/inference/reservation.test.ts`: the bound for a request of 1 KB of 4-byte characters (emoji) and of 1 KB of ASCII equals the formula; the bound grows with messages and tools; a per-request fee is added when configured.
- `tests/inference/ledger.test.ts`: public daily budget formula across days (fake clock); public spend cannot reduce the judge budget; reconciliation lowers a reservation to the reported usage; missing usage keeps it; outstanding reservations reduce both budgets; after an overrun, the judge budget equals the remaining credit when that is lower than the reserve.
- `tests/inference/hold.test.ts`: an overrun writes the hold and calls the alert once; the public pool stays closed across a UTC rollover (fake clock) and across a restart (a new store client on the same backing store); the judge pool keeps serving while its budget allows; `resume-free` refuses without a balance, refuses a balance below the ledger's remaining credit, and with a valid balance removes the hold and writes the audit record.
- `tests/inference/quota.test.ts`: each cap returns 429 with its text at N+1; in-flight slots freed on completion and after the lease on crash.
- `tests/inference/proxy.test.ts` (upstream mocked at the network boundary): server key upstream, no cookie upstream; unknown field `n` or `logprobs` refused; oversize body, too many messages, too many or too large tools refused; upstream body has `n` 1, `max_tokens` and `include_usage`; two parallel requests when only one reservation fits give one 429; counters unavailable gives 503 and no upstream call; upstream 500 and timeout give 502 with text; an upstream stream that sends partial content and then breaks, or ends without `finish_reason` or `usage`, gives 502 and no partial content in the body; visitor disconnect aborts upstream and keeps the reservation; no retry after failure; cross-origin refused; provider-looking Bearer refused and not forwarded.
- `tests/inference/redaction.test.ts`: no part of a key or cookie in logs.
- `tests/ops/credit-check.test.ts`: GitHub API mocked at the network boundary; one issue per threshold; none when below; wrong `CRON_SECRET` gives 401.
- `e2e/free-path.spec.ts` (mock upstream): a new visitor chats with no key; a scripted turn with an agent delegation and a `website_search_site_content` result is followed by a successful next model call through the proxy (no 400); Retrofit's own agent uses its published default router (completes the Phase 4 §6 case); renewal in a real browser keeps `sid` and the spent count (read through a test-only status field when `fixturesEnabled`); two tabs share one session; a renewal across UTC midnight keeps the session count and resets the daily pool (fake server clock in fixtures mode); at the session cap the chat shows the cap text and the banner offers "Use your own key"; with the mock upstream sending a partial answer and then failing, the chat shows "The free AI provider did not answer" and no partial answer, and the runtime makes no second request.
- `e2e/key-panel.spec.ts` (extended): with a visitor key, no request goes to `/api/inference/*`.

## Contract probe

With the owner's key, through the local proxy to `https://api.otari.ai/api/v1`:

1. One streamed completion with one tool. Record the date, model, status, that a `tool_calls` delta arrived, that a `usage` object arrived with `include_usage`, and that the mock fixture's stream format matches.
2. Three requests chosen to stress the bound: 8 KB of emoji, 8 KB of mixed CJK text, and 8 KB of random base64. For each, record `usage.prompt_tokens` and the computed input bound. Every reported value must be at or below its bound. If one is above, stop: raise the framing allowance or change the bound, and record the decision before acceptance.

Never record the key. The probe tests the protocol shape and the bound assumption, not cost over time or sustained availability.

## Automated success criteria

- The full gate passes.

## Manual success criteria

- Contract probe recorded; Otari limit and balance findings recorded; caps and reserve confirmed by the owner.
- The owner accepts the reserve guarantee level in writing in the phase handoff: provider-backed isolation (two capped keys), or the qualified guarantee in the parent plan's words.

## Independent work units

- `[batch-eligible]` Unit A: token, session routes, judge page and tests.
- `[batch-eligible]` Unit B: schema, reservation, ledger, quota and tests.
- `[batch-eligible]` Unit C: proxy routes, redaction and tests (stubs ledger and quota until merged).
- `[batch-eligible]` Unit D: credit check and tests.
- Unit E (integration owner): client integration and e2e specs.

## Stuck states in this phase

Free cap reached, session expired, Otari error or mid-stream failure, counters unavailable, overrun hold, credit threshold. See the parent plan table.

## Exit

Stop for owner acceptance.
