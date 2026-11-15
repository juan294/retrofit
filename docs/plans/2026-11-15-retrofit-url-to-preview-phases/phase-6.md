# Phase 6: Free inference with spend control, judge reserve and credit alert

Parent plan: [2026-11-15-retrofit-url-to-preview.md](../2026-11-15-retrofit-url-to-preview.md).

## Goal

A visitor or judge without a key can use the preview and Retrofit's own agent. The runtime sends the placeholder key `retrofit-free` to Retrofit's same-origin endpoint `/api/inference/v1` as an explicit router override. The credential is an HttpOnly session cookie. Every forwarded request is bounded and its cost is reserved against a ledger before it reaches Otari. Public use can never spend the judge reserve. The owner is alerted when credit runs low. A visitor's own key never reaches this endpoint.

## Entry conditions

- Phase 5 accepted.
- Owner authorization to use the Otari account and its credits. The owner creates an Otari API key in the dashboard (no CLI exists for it) and places it in the ignored `.env` as `OTARI_API_KEY`.
- Check, with that key, whether Otari offers a per-key spending limit or a balance or usage API. If a per-key limit exists, the owner sets it to the credit amount; record the result. If none exists, the ledger below is the only cap, and the handoff says so.
- Read the price per million input and output tokens for `alibaba/qwen3.8-flash` from `GET https://api.otari.ai/api/v1/models` and record it.
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
| `FREE_MAX_MESSAGES` | 80 | Messages per request |
| `FREE_MAX_TOOLS` | 16 | Tools per request; each tool definition at most 4096 bytes |
| `FREE_INFLIGHT_PER_SESSION` | 2 | Concurrent requests per session |
| `FREE_INFLIGHT_GLOBAL` | 16 | Concurrent requests overall |
| `FREE_CALLS_PER_SESSION` | 40 | Public session calls |
| `FREE_SESSIONS_PER_CLIENT_HOUR` | 6 | New sessions per client per hour |
| `JUDGE_CALLS_PER_SESSION` | 200 | Judge session calls |
| `JUDGE_SESSIONS_PER_CLIENT_DAY` | 3 | Judge sessions per client per day |
| `FREE_UPSTREAM_TIMEOUT_MS` | 45000 | Upstream timeout (15 s margin inside `maxDuration` 60 s) |
| `CREDIT_ALERT_THRESHOLDS` | `0.5,0.8,0.95` | Fractions of the ledger that raise an alert |
| `ALERT_GITHUB_TOKEN` | required on Vercel | Fine-grained token with Issues write on `juan294/retrofit` only |

Add them to `src/lib/config.ts` with tests.

## Changes

### Sessions

- `src/lib/inference/token.ts`: HMAC-SHA-256 with `SESSION_SECRET`; `SessionClaims`: `sid`, `iat`, `exp` (2 h), `client`, `pool` (`public` or `judge`).
- `src/app/api/inference/session/route.ts` (`POST`, same-origin only): with no valid cookie, applies the per-client cap and creates a session; with a valid cookie, renews it with the same `sid`, `pool` and counters. Cookie `retrofit_session`: `HttpOnly`, `Secure` on HTTPS, `SameSite=Strict`, `Path=/api/inference`, `Max-Age` 7200. Renewal lives under `/api/inference` so that the browser sends the cookie to it.
- `src/app/judges/page.tsx` and `POST /api/inference/session/judge`: a correct code (constant-time compare, never logged) makes the current session a judge session.

### Ledger and quotas

- `src/lib/inference/ledger.ts`: spend in micro-USD per UTC day and pool, plus a running total.
  - Public daily budget = `max(0, FREE_CREDIT_USD - JUDGE_RESERVE_USD - publicSpentTotal) / daysLeft(FREE_SERVICE_END)`, computed at the start of each UTC day.
  - Judge budget = `JUDGE_RESERVE_USD - judgeSpentTotal`, available at any time. Public spend never draws on it.
- `src/lib/inference/quota.ts`: session calls, client sessions, in-flight counters (per session and global, with leases so a crashed request frees its slot after 60 s).

### Proxy

```
@ proxyChat(request) -> streamed response
ctx: token, quota, ledger, Store, Otari (server key), Config
pre: Authorization is "Bearer retrofit-free"
do:
  1. validate same origin (Sec-Fetch-Site same-origin or Origin equals PUBLIC_ORIGIN) and the retrofit_session cookie
  2. validate body against the allowlist {model, messages, tools, tool_choice, stream, temperature, top_p} and all size limits
  3. acquire in-flight slots; reserve cost = estimate(input bytes / 3 tokens) at input price + FREE_MAX_TOKENS at output price
  4. write upstream body: allowed fields, model FREE_MODEL, n 1, stream true, stream_options.include_usage true, max_tokens FREE_MAX_TOKENS
  5. stream the response through; on completion reconcile the reservation to the reported usage
br: unknown field, wrong model or oversize -> 400 with text; any other Bearer -> 401, nothing forwarded
fx: counters, reservation, ledger; one upstream POST
fail: counters unavailable -> 503 (never forward without a reservation); upstream error or timeout -> 502; mid-stream failure -> emit an error event and close
risk: no usage reported -> keep the full reservation; visitor disconnect -> abort upstream and keep the reservation
```

- Error bodies use the OpenAI error shape so the runtime shows them in chat.
- `src/app/api/inference/v1/models/route.ts`: lists only `FREE_MODEL`.
- `src/app/api/inference/status/route.ts`: `{available, pool, reason}` without amounts.
- Logging: one redaction helper removes `authorization`, `cookie`, `set-cookie` and any value with a prefix from `providers.ts`.

### Credit alert

- `src/app/api/cron/credit-check/route.ts`: daily (Vercel Cron in Phase 7), `Authorization: Bearer <CRON_SECRET>`. Compares the ledger total with `FREE_CREDIT_USD`. When a threshold is first crossed, or the judge reserve is below 25%, it opens one GitHub issue in `juan294/retrofit` titled "Free AI credit threshold reached" with the percentage and pool only (no amounts per visitor, no keys). It records the threshold so it does not repeat.

### Client

- `Preview.tsx` and the landing assistant: with no visitor key, `POST /api/inference/session`, then boot with `router` `${location.origin}/api/inference/v1`, `byokKey` `retrofit-free`, `model` `FREE_MODEL`. Renew every 30 min and on `visibilitychange`. The fetch guard allows the router origin (same origin). When the visitor connects a key, reboot with the provider router. The key panel shows "Using Retrofit's free AI" and "Use your own key".

## Tests (write first)

- `tests/inference/token.test.ts`: valid, tampered, expired, wrong secret.
- `tests/inference/session.test.ts`: renewal with a valid cookie keeps `sid`, `pool` and counters; the per-client cap applies only to new sessions; judge upgrade with a wrong code fails.
- `tests/inference/ledger.test.ts`: public daily budget formula across days (fake clock); public spend cannot reduce the judge budget; reconciliation lowers a reservation to the reported usage; missing usage keeps it.
- `tests/inference/quota.test.ts`: each cap returns 429 with its text at N+1; in-flight slots freed on completion and after the lease on crash.
- `tests/inference/proxy.test.ts` (upstream mocked at the network boundary): server key upstream, no cookie upstream; unknown field `n` or `logprobs` refused; oversize body, too many messages, too many or too large tools refused; upstream body has `n` 1, `max_tokens` and `include_usage`; two parallel requests when only one reservation fits give one 429; counters unavailable gives 503 and no upstream call; upstream 500, timeout and mid-stream failure give their texts; visitor disconnect aborts upstream; no retry after failure; cross-origin refused; provider-looking Bearer refused and not forwarded.
- `tests/inference/redaction.test.ts`: no part of a key or cookie in logs.
- `tests/ops/credit-check.test.ts`: GitHub API mocked at the network boundary; one issue per threshold; none when below; wrong `CRON_SECRET` gives 401.
- `e2e/free-path.spec.ts` (mock upstream): a new visitor chats with no key; Retrofit's own agent uses its published default router (completes the Phase 4 §6 case); renewal in a real browser keeps `sid` and the spent count (read through a test-only status field when `fixturesEnabled`); two tabs share one session; a renewal across UTC midnight keeps the session count and resets the daily pool (fake server clock in fixtures mode); at the session cap the chat shows the cap text and the banner offers "Use your own key".
- `e2e/key-panel.spec.ts` (extended): with a visitor key, no request goes to `/api/inference/*`.

## Contract probe

Once, with the owner's key, through the local proxy to `https://api.otari.ai/api/v1`: one streamed completion with one tool. Record the date, model, status, that a `tool_calls` delta arrived, that a `usage` object arrived with `include_usage`, and that the mock fixture's stream format matches. Never record the key. This proves the protocol shape, not cost or sustained availability.

## Automated success criteria

- The full gate passes.

## Manual success criteria

- Contract probe recorded; Otari limit and balance findings recorded; caps and reserve confirmed by the owner.

## Independent work units

- `[batch-eligible]` Unit A: token, session routes, judge page and tests.
- `[batch-eligible]` Unit B: ledger, quota and tests.
- `[batch-eligible]` Unit C: proxy routes, redaction and tests (stubs ledger and quota until merged).
- `[batch-eligible]` Unit D: credit check and tests.
- Unit E (integration owner): client integration and e2e specs.

## Stuck states in this phase

Free cap reached, session expired, Otari error, counters unavailable, credit threshold. See the parent plan table.

## Exit

Stop for owner acceptance.
