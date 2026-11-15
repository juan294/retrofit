# Phase 5: Free inference through Otari with caps and the judge pool

Parent plan: [2026-11-15-retrofit-url-to-preview.md](../2026-11-15-retrofit-url-to-preview.md).

## Goal

A visitor or judge without a key can use the preview and Retrofit's own agent. The runtime sends the fixed placeholder key `retrofit-free` to Retrofit's same-origin endpoint `/api/inference/v1`, given as an explicit router override. The real credential is an HttpOnly session cookie. The endpoint checks caps and forwards to hosted Otari with Retrofit's server key. A visitor's own key never reaches this endpoint.

## Entry conditions

- Phase 4 accepted.
- Owner authorization to use the Otari account and its hackathon credits. The owner creates an Otari API key in the Otari dashboard (no CLI exists for it) and places it in the ignored local `.env` as `OTARI_API_KEY` for the contract probe.
- The owner sets the caps below or accepts the defaults after checking the credit balance, and generates a `JUDGE_CODE` for the Devpost text.

## Configuration (defaults)

| Variable | Default | Meaning |
| --- | --- | --- |
| `FREE_MODEL` | `alibaba/qwen3.8-flash` | The only model the endpoint accepts |
| `FREE_MAX_TOKENS` | 1024 | Added to every upstream request (avoids the Otari failure without `max_tokens`, `otari.md`) |
| `FREE_CALLS_PER_SESSION` | 40 | Model calls per public session |
| `FREE_SESSIONS_PER_CLIENT_HOUR` | 6 | New sessions per client per hour |
| `FREE_CALLS_PER_DAY` | 2000 | Public pool, model calls per UTC day |
| `JUDGE_CODE` | required on Vercel | Unlocks the judge pool |
| `JUDGE_CALLS_PER_SESSION` | 200 | Model calls per judge session |
| `JUDGE_CALLS_PER_DAY` | 2000 | Judge pool, model calls per UTC day |
| `FREE_UPSTREAM_TIMEOUT_MS` | 60000 | Upstream timeout |

Add these to `src/lib/config.ts` with tests, as in Phase 1.

## Changes

- `src/lib/inference/token.ts`: HMAC-SHA-256 value with `SESSION_SECRET`; `SessionClaims`: `sid`, `iat`, `exp` (2 h), `client` (client hash), `pool` (`public` or `judge`). Constant-time compare.
- `src/app/api/session/route.ts` (`POST`, same-origin only): applies the per-client cap, sets cookie `retrofit_session` (`HttpOnly`, `Secure` on HTTPS, `SameSite=Strict`, `Path=/api/inference`, `Max-Age` 7200) and returns `{expiresAt, pool}`. A renewal keeps `sid` and its counters.
- `src/app/judges/page.tsx`: a form for the judge code; a correct code makes the next session use the judge pool. The code is compared in constant time and never logged.
- `src/lib/inference/quota.ts`: session, client and pool counters on the `Store`.
- `src/app/api/inference/v1/models/route.ts`: lists only `FREE_MODEL` in the OpenAI format.
- `src/app/api/inference/v1/chat/completions/route.ts`:

```
@ proxyChat(request) -> streamed response
ctx: token, quota, Store, Otari (server key), Config
pre: Authorization is "Bearer retrofit-free"
do:
  1. validate same origin (Sec-Fetch-Site same-origin or Origin equals PUBLIC_ORIGIN) -> else 403
  2. validate retrofit_session cookie (missing, bad or expired -> 401 with recovery text)
  3. validate body: model equals FREE_MODEL; messages array; tools optional
  4. increment session and pool counters (over cap -> 429 with reason text)
  5. write upstream request with the server key and max_tokens; stream the response through
br: any other Bearer value -> 401 "This endpoint takes Retrofit sessions only"; nothing forwarded
fx: counters; one upstream POST
fail: upstream error or timeout -> 502 with recovery text; never retried
risk: never log Authorization, cookies or bodies; never echo the server key
```

- Error bodies use the OpenAI error shape (`{"error": {"message": ...}}`), so the runtime shows the message in chat.
- `src/app/api/inference/status/route.ts`: `{available, reason}` for the banner, without counts.
- `Preview.tsx` and the landing assistant: with no visitor key, call `POST /api/session`, then boot with `router` `${location.origin}/api/inference/v1`, `byokKey` `retrofit-free`, `model` `FREE_MODEL`. Renew the session every 30 min and on `visibilitychange`; the runtime does not need a reboot because the cookie travels with each same-origin request. When the visitor connects a key, reboot with the provider router. The key panel shows "Using Retrofit's free AI" and "Use your own key".
- Logging: one redaction helper for all route handlers removes `authorization`, `cookie`, `set-cookie` and any value matching a prefix in `providers.ts`.

## Tests (write first)

- `tests/inference/token.test.ts`: valid, tampered, expired, wrong secret; renewal keeps `sid`.
- `tests/inference/quota.test.ts`: each cap returns 429 with its exact text at N+1; the judge pool is separate from the public pool; daily windows reset at UTC midnight with a fake clock.
- `tests/inference/proxy.test.ts` (upstream mocked at the network boundary): the server key is sent upstream and the session cookie is not; `max_tokens` is added; a wrong model is refused; a provider-looking Bearer is refused and not forwarded; a cross-origin request is refused with 403; upstream 500 and timeout give 502 with text; no second upstream call after a failure.
- `tests/inference/judge.test.ts`: a wrong code gives no judge pool; a correct code gives `pool: judge`.
- `tests/inference/redaction.test.ts`: logs for a request with `Authorization: Bearer sk-or-v1-...` and a session cookie contain no part of either.
- `e2e/free-path.spec.ts` (mock upstream): a new visitor chats on the preview with no key; the published default router of Retrofit's own manifest is used without the runtime's own profile (completes the Phase 4 §6 case); at the session cap the chat shows the cap text and the banner offers "Use your own key"; after a forced renewal, the next model call carries the new cookie value.
- `e2e/key-panel.spec.ts` (extended): after the visitor connects a key, no request goes to `/api/inference/*`.

## Contract probe

Run once with the owner's `OTARI_API_KEY` against `https://api.otari.ai/api/v1` through the local proxy: one streamed chat completion with one tool definition. Record in the phase handoff the date, model, HTTP status, that a `tool_calls` delta arrived, and that the mock fixture's stream format matches (event field names and order). Never record the key. Run it again before the Phase 6 release if the mock fixture changes.

## Automated success criteria

- The full gate passes.

## Manual success criteria

- Contract probe recorded.
- The owner confirms the cap values and has the judge code.

## Independent work units

- `[batch-eligible]` Unit A: token, session route, judge page, quota and their tests.
- `[batch-eligible]` Unit B: proxy routes, redaction and their tests (stubs the quota interface until A is merged).
- Unit C (integration owner): client integration and e2e specs.

## Stuck states in this phase

Free cap reached, session expired, Otari error. See the parent plan table.

## Exit

Stop for owner acceptance.
