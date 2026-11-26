import { isSameOrigin } from "@/lib/analysis/run";
import { json } from "@/lib/api/json";
import { clientIdFromRequest, ttlUntil } from "@/lib/fetch/limits";
import { openAlert, overrunAlert } from "@/lib/ops/alert";
import type { ServerDeps } from "@/lib/server/runtime";
import { CountersUnavailable, FREE_PLACEHOLDER_KEY, HOLD_MESSAGE, UNAVAILABLE_MESSAGE } from "./errors";
import { type OverrunAlert, createHold, holdId, recordOverrun } from "./hold";
import { type Pool, counterDepsOf, createLedger } from "./ledger";
import { callCap, createQuota, refusal, type QuotaRefusal } from "./quota";
import { redact, redactText } from "./redact";
import { reservationFor, usageCharge } from "./reservation";
import { type ChatRequest, parseChatRequest } from "./schema";
import { readSession, sessionTexts } from "./session";

/**
 * Retrofit's free inference proxy (phase-6.md "Proxy"; parent plan "Free path
 * responses are buffered", "Free path authentication", "Spend control").
 *
 * POST /api/inference/v1/chat/completions takes only `Authorization: Bearer
 * retrofit-free` plus the HttpOnly session cookie, bounds the request, reserves
 * its cost bound before anything reaches the provider, makes exactly one
 * upstream POST with the server key of the session's pool, reads the whole
 * upstream stream, reconciles the reported usage and answers with all events in
 * one SSE body. Any failure is an HTTP error with an OpenAI-shaped body, so the
 * unchanged runtime (`runtime/llm.js:128-131`) shows its message and never sees
 * part of an answer. The proxy never retries.
 */

export const FREE_FAILED_MESSAGE = "The free AI provider did not answer. Try again, or use your own key.";
/** A judge's texts for a failure that ends by itself never ask for a paid key. */
export const JUDGE_FAILED_MESSAGE = "The free AI provider did not answer. Try again.";
export const AUTH_MESSAGE = "Retrofit's free AI accepts only its own placeholder key. Your own key goes to your provider, never to Retrofit.";

/** Bound on the overrun GitHub call, so 45 s upstream plus the alert stays inside maxDuration 60 s; the daily credit check retries a failure. */
export const OVERRUN_ALERT_TIMEOUT_MS = 5000;

/** The upstream answer is a short buffered completion (max_tokens 1024); anything larger is refused. */
export const MAX_UPSTREAM_BYTES = 2 * 1024 * 1024;

type ErrorType = "invalid_request_error" | "authentication_error" | "permission_error" | "rate_limit_error" | "server_error" | "service_unavailable";

/** The OpenAI error shape, so the runtime shows `message` in chat. */
function apiError(status: number, message: string, type: ErrorType, code: string): Response {
  return json(status, { error: { message, type, code } });
}

const unavailable = (pool: Pool | null = null, code = "unavailable") => apiError(503, pool === "judge" ? sessionTexts.judgeUnavailable : UNAVAILABLE_MESSAGE, "service_unavailable", code);
const failed = (code: string, pool: Pool) => apiError(502, pool === "judge" ? JUDGE_FAILED_MESSAGE : FREE_FAILED_MESSAGE, "server_error", code);
/** 429 for a cap; with `retryAt` and Retry-After when a time ends it. */
function capped({ reason, message, retryAt }: QuotaRefusal, now: number): Response {
  if (retryAt === undefined) return apiError(429, message, "rate_limit_error", reason);
  const res = json(429, { error: { message, type: "rate_limit_error", code: reason }, retryAt: new Date(retryAt).toISOString() });
  res.headers.set("retry-after", String(ttlUntil(retryAt, now)));
  return res;
}
const held = () => apiError(429, HOLD_MESSAGE, "rate_limit_error", "free_paused");

type Logger = (event: string, fields?: Record<string, unknown>) => void;

/** Every proxy log line goes through the redaction helper, with the configured secrets. */
function logger(deps: ServerDeps): Logger {
  const f = deps.config.free;
  const secrets = [f.keyPublic, f.keyJudge, f.alertGithubToken, deps.config.cronSecret, f.judgeCode, deps.config.sessionSecret];
  return (event, fields = {}) => console.error(redactText(`free inference: ${event} ${JSON.stringify(redact(fields, secrets))}`, secrets));
}

const describeError = (e: unknown): string => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));

const networkId = (request: Request, deps: ServerDeps): string => clientIdFromRequest(request, deps.config, deps.clock());

const keyFor = (deps: ServerDeps, pool: Pool): string | null => (pool === "judge" ? deps.config.free.keyJudge : deps.config.free.keyPublic);

type BodyResult = { ok: true; text: string } | { ok: false; tooLarge: boolean };

/** Reads at most `max` bytes of the request body; refuses past that before any parsing. */
async function readLimited(request: Request, max: number): Promise<BodyResult> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) return { ok: false, tooLarge: true };
  if (!request.body) return { ok: false, tooLarge: false };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel().catch(() => {});
        return { ok: false, tooLarge: true };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, tooLarge: false };
  }
  return { ok: true, text: Buffer.concat(chunks).toString("utf8") };
}

class UpstreamFailure extends Error {
  constructor(readonly code: string, detail: string) {
    super(detail);
    this.name = "UpstreamFailure";
  }
}

/** Reads the whole body, failing at once when `signal` aborts (timeout or visitor disconnect). */
async function readAll(body: ReadableStream<Uint8Array>, signal: AbortSignal, chunks: Uint8Array[]): Promise<string> {
  const reader = body.getReader();
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason ?? new DOMException("aborted", "AbortError"));
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  aborted.catch(() => {});
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      size += value.byteLength;
      if (size > MAX_UPSTREAM_BYTES) throw new UpstreamFailure("upstream_too_large", "upstream answer too large");
      chunks.push(value);
    }
  } catch (e) {
    await reader.cancel().catch(() => {});
    throw e;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
  return Buffer.concat(chunks).toString("utf8");
}

type Usage = { promptTokens: number; completionTokens: number };

const usageFrom = (value: unknown): Usage | null => {
  if (typeof value !== "object" || value === null) return null;
  const u = value as { prompt_tokens?: unknown; completion_tokens?: unknown };
  return isCount(u.prompt_tokens) && isCount(u.completion_tokens) ? { promptTokens: u.prompt_tokens, completionTokens: u.completion_tokens } : null;
};

/** The trimmed payload of every `data:` line; other lines (comments, keep-alives) are dropped. */
function* dataPayloads(text: string): Generator<string> {
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("data:")) yield line.slice(5).trim();
  }
}

/** The last usage object in a partial or failed stream; malformed lines are skipped. */
function lastUsage(text: string): Usage | null {
  let usage: Usage | null = null;
  for (const payload of dataPayloads(text)) {
    try {
      usage = usageFrom((JSON.parse(payload) as { usage?: unknown }).usage) ?? usage;
    } catch {
      // Partial or malformed line: keep the last usage seen.
    }
  }
  return usage;
}

interface Completion {
  readonly events: unknown[];
  readonly usage: Usage | null;
  readonly finished: boolean;
}

const isCount = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/** Parses the SSE text: every `data:` line must be JSON or `[DONE]`; other lines (comments, keep-alives) are dropped. */
function parseStream(text: string): Completion {
  const events: unknown[] = [];
  let usage: Completion["usage"] = null;
  let finished = false;
  for (const payload of dataPayloads(text)) {
    if (payload === "[DONE]") continue;
    let event: unknown;
    try {
      event = JSON.parse(payload);
    } catch {
      throw new UpstreamFailure("upstream_malformed", "malformed stream event");
    }
    if (typeof event !== "object" || event === null || Array.isArray(event)) throw new UpstreamFailure("upstream_malformed", "stream event is not an object");
    const e = event as { error?: unknown; usage?: unknown; choices?: unknown };
    if (e.error !== undefined) throw new UpstreamFailure("upstream_error_event", "stream carried an error event");
    if (Array.isArray(e.choices) && e.choices.some((c) => typeof c === "object" && c !== null && typeof (c as { finish_reason?: unknown }).finish_reason === "string")) {
      finished = true;
    }
    usage = usageFrom(e.usage) ?? usage;
    events.push(event);
  }
  return { events, usage, finished };
}

/** The upstream body: the validated fields plus the fields the server forces. */
function upstreamBody(body: ChatRequest, deps: ServerDeps): string {
  const free = deps.config.free;
  return JSON.stringify({ ...body, model: free.model, n: 1, stream: true, stream_options: { include_usage: true }, max_tokens: free.maxTokens });
}

function sseBody(events: readonly unknown[]): Response {
  const text = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(text, { status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
}

/**
 * POST /api/inference/v1/chat/completions. Statuses: 200 one buffered SSE body;
 * 400 schema or size refusal; 401 any credential but `Bearer retrofit-free`, or
 * no valid session; 403 cross-origin; 429 a cap or the overrun hold; 502 any
 * upstream failure (non-OK, timeout, broken or incomplete stream, visitor
 * disconnect); 503 counters unavailable or no server key for the pool.
 */
export async function handleChat(request: Request, deps: ServerDeps, opts: { signal?: AbortSignal } = {}): Promise<Response> {
  const log = logger(deps);
  const free = deps.config.free;

  if (!isSameOrigin(request, deps.config)) return apiError(403, sessionTexts.crossOrigin, "permission_error", "cross_origin");
  // Exact match: a visitor key (or anything else) is refused, never forwarded and never logged.
  if (request.headers.get("authorization") !== `Bearer ${FREE_PLACEHOLDER_KEY}`) {
    log("refused a request without the placeholder key");
    return apiError(401, AUTH_MESSAGE, "authentication_error", "invalid_api_key");
  }

  let sid: string;
  let pool: Pool;
  try {
    const session = await readSession(request, deps);
    if (!session) return apiError(401, sessionTexts.expired, "authentication_error", "session_expired");
    ({ sid, pool } = session.claims);
  } catch (e) {
    log("session store unavailable", { error: describeError(e) });
    return unavailable();
  }

  const serverKey = keyFor(deps, pool);
  if (!serverKey) {
    log("no server key configured", { pool });
    return unavailable(pool, "not_configured");
  }

  const raw = await readLimited(request, free.maxBodyBytes);
  if (!raw.ok) {
    const message = raw.tooLarge ? `The request is larger than ${free.maxBodyBytes} bytes.` : "The request body could not be read.";
    return apiError(400, message, "invalid_request_error", raw.tooLarge ? "request_too_large" : "invalid_body");
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw.text);
  } catch {
    return apiError(400, "The request body must be JSON.", "invalid_request_error", "invalid_json");
  }
  const parsed = parseChatRequest(parsedJson, free);
  if (!parsed.ok) return apiError(400, parsed.message, "invalid_request_error", "invalid_request");
  const body = parsed.body;

  const counterDeps = counterDepsOf(deps);
  const quota = createQuota(counterDeps);
  const ledger = createLedger(counterDeps);
  const hold = createHold(counterDeps);

  let release: (() => Promise<void>) | null = null;
  try {
    // Counters, then the reservation: nothing is forwarded without one.
    let reservationId: string;
    let reservation: ReturnType<typeof reservationFor>;
    try {
      if (pool === "public" && (await hold.read()) !== null) return held();
      const slot = await quota.acquireInflight(sid, pool);
      if (!slot.ok) return capped(slot, deps.clock());
      release = slot.release;
      const admitted = await quota.admitCall({ sid, pool, network: networkId(request, deps) });
      if (!admitted.ok) return capped(admitted, deps.clock());
      reservation = reservationFor(body, free);
      const reserved = await ledger.reserve({ pool, sid, microUsd: reservation.microUsd });
      if (!reserved.ok) return reserved.reason === "hold" ? held() : capped(refusal(reserved.reason, pool), deps.clock());
      reservationId = reserved.reservationId;
    } catch (e) {
      if (!(e instanceof CountersUnavailable)) throw e;
      log("counters unavailable", { error: describeError(e) });
      return unavailable(pool);
    }

    /**
     * Records the outcome. A complete answer is charged its reported usage. A
     * failed one is charged the full reservation, or the reported usage when it
     * is higher; without usage the reservation is kept (an upper bound under
     * the stated assumption). Reported usage above the reservation, or prompt
     * tokens above the input bound, writes the hold and alerts.
     */
    const settle = async (usage: Usage | null, complete: boolean): Promise<void> => {
      try {
        const reported = usage ? usageCharge(usage, free) : null;
        const charge = reported === null ? null : complete ? reported : Math.max(reported, reservation.microUsd);
        const result = await ledger.reconcile(reservationId, charge);
        const inputBoundExceeded = usage !== null && usage.promptTokens > reservation.inputTokenBound;
        if (!result.overrun && !inputBoundExceeded) return;
        log("reported usage above the bound; holding the public pool", {
          pool,
          reservationMicroUsd: reservation.microUsd,
          overrunMicroUsd: result.overrunMicroUsd,
          inputBoundExceeded,
        });
        const alert: OverrunAlert = async () => {
          const record = await hold.read();
          const id = record ? holdId(record) : String(deps.clock());
          await openAlert(overrunAlert(id), { config: deps.config, store: deps.store }, { timeoutMs: OVERRUN_ALERT_TIMEOUT_MS });
        };
        await recordOverrun(counterDeps, result, alert, { inputBoundExceeded });
      } catch (e) {
        // The reservation stays outstanding and is charged in full when stale; the cron retries a failed alert.
        log("reconcile or hold failed", { error: describeError(e) });
      }
    };

    const outcome = await callUpstream(request, deps, serverKey, body, opts.signal);

    if (!outcome.ok) {
      await settle(outcome.usage, false);
      log("upstream failed", { code: outcome.code, detail: outcome.detail, pool });
      return failed(outcome.code, pool);
    }

    const { completion } = outcome;
    if (!completion.finished || !completion.usage) {
      await settle(completion.usage, false);
      const code = completion.finished ? "upstream_no_usage" : "upstream_incomplete";
      log("upstream stream incomplete", { code, pool });
      return failed(code, pool);
    }

    await settle(completion.usage, true);
    return sseBody(completion.events);
  } catch (e) {
    log("unexpected failure", { error: describeError(e) });
    return unavailable(pool);
  } finally {
    if (release) await release().catch((e: unknown) => log("in-flight release failed", { error: describeError(e) }));
  }
}

/** A failure carries the last usage the stream reported before it failed, if any. */
type UpstreamOutcome = { ok: true; completion: Completion } | { ok: false; code: string; detail: string; usage: Usage | null };

/**
 * One upstream POST, no retry. The whole stream is read within
 * `upstreamTimeoutMs`; a visitor disconnect (request or caller signal) aborts it.
 */
async function callUpstream(request: Request, deps: ServerDeps, serverKey: string, body: ChatRequest, extra: AbortSignal | undefined): Promise<UpstreamOutcome> {
  const free = deps.config.free;
  const controller = new AbortController();
  let why: "timeout" | "disconnect" | null = null;
  const timer = setTimeout(() => {
    why ??= "timeout";
    controller.abort(new DOMException("upstream timeout", "TimeoutError"));
  }, free.upstreamTimeoutMs);
  const visitorSignals = [request.signal, extra].filter((s): s is AbortSignal => s !== undefined);
  const onDisconnect = () => {
    why ??= "disconnect";
    controller.abort(new DOMException("visitor disconnected", "AbortError"));
  };
  for (const s of visitorSignals) {
    if (s.aborted) onDisconnect();
    else s.addEventListener("abort", onDisconnect, { once: true });
  }

  const chunks: Uint8Array[] = [];
  try {
    const res = await fetch(`${free.upstreamUrl}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${serverKey}`, "content-type": "application/json", accept: "text/event-stream" },
      body: upstreamBody(body, deps),
      signal: controller.signal,
      redirect: "error",
      cache: "no-store",
    });
    if (!res.ok || !res.body) {
      await res.body?.cancel().catch(() => {});
      return { ok: false, code: "upstream_status", detail: `upstream answered ${res.status}`, usage: null };
    }
    const text = await readAll(res.body, controller.signal, chunks);
    return { ok: true, completion: parseStream(text) };
  } catch (e) {
    const usage = lastUsage(Buffer.concat(chunks).toString("utf8"));
    if (why === "timeout") return { ok: false, code: "upstream_timeout", detail: `no complete answer within ${free.upstreamTimeoutMs} ms`, usage };
    if (why === "disconnect") return { ok: false, code: "visitor_disconnected", detail: "visitor disconnected; upstream aborted", usage };
    if (e instanceof UpstreamFailure) return { ok: false, code: e.code, detail: e.message, usage };
    return { ok: false, code: "upstream_broken", detail: describeError(e), usage };
  } finally {
    clearTimeout(timer);
    for (const s of visitorSignals) s.removeEventListener("abort", onDisconnect);
  }
}

/** GET /api/inference/v1/models: only the free model, in the OpenAI list shape. Public: the runtime calls it without credentials. */
export function handleModels(deps: Pick<ServerDeps, "config">): Response {
  return json(200, { object: "list", data: [{ id: deps.config.free.model, object: "model", created: 0, owned_by: "retrofit" }] });
}

export type StatusReason = "no_session" | "not_configured" | "hold" | "unavailable" | "session_calls" | "judge_session_calls" | "judge_network_calls" | "public_pool" | "judge_pool" | "ledger";

/**
 * GET /api/inference/status -> 200 `{available, pool, reason}` with no amounts.
 * `reason` is null when available. In fixtures mode only, also `{sid, calls,
 * publicSpentTodayMicro}` for the e2e renewal and UTC-midnight tests. Advisory: the chat route makes the real decision.
 */
export async function handleStatus(request: Request, deps: ServerDeps): Promise<Response> {
  const log = logger(deps);
  const free = deps.config.free;
  const answer = (available: boolean, pool: Pool | null, reason: StatusReason | null, extra: Record<string, unknown> = {}) =>
    json(200, { available, pool, reason, ...(deps.config.fixturesEnabled ? extra : {}) });
  try {
    const session = await readSession(request, deps);
    if (!session) return answer(false, null, "no_session");
    const { sid, pool } = session.claims;
    const counterDeps = counterDepsOf(deps);
    const quota = createQuota(counterDeps);
    const calls = await quota.callsUsed({ sid, pool });
    const b = await createLedger(counterDeps).budgets();
    const extra = { sid, calls, publicSpentTodayMicro: b.publicSpentTodayMicro };
    if (!keyFor(deps, pool)) return answer(false, pool, "not_configured", extra);
    if (pool === "public" && (b.held || (await createHold(counterDeps).read()) !== null)) return answer(false, pool, "hold", extra);
    if (calls >= callCap(pool, free)) return answer(false, pool, pool === "judge" ? "judge_session_calls" : "session_calls", extra);
    if (pool === "judge" && (await quota.networkCapReached(networkId(request, deps)))) return answer(false, pool, "judge_network_calls", extra);
    if (b.remainingCreditMicro <= 0) return answer(false, pool, "ledger", extra);
    if (pool === "public" && b.publicDailyMicro - b.publicSpentTodayMicro <= 0) return answer(false, pool, "public_pool", extra);
    if (pool === "judge" && b.judgeRemainingMicro <= 0) return answer(false, pool, "judge_pool", extra);
    return answer(true, pool, null, extra);
  } catch (e) {
    log("status unavailable", { error: describeError(e) });
    return answer(false, null, "unavailable");
  }
}
