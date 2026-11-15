import { isSameOrigin } from "@/lib/analysis/run";
import { json } from "@/lib/api/json";
import { openAlert, overrunAlert } from "@/lib/ops/alert";
import type { ServerDeps } from "@/lib/server/runtime";
import { CountersUnavailable, HOLD_MESSAGE, UNAVAILABLE_MESSAGE } from "./errors";
import { type OverrunAlert, createHold, recordOverrun } from "./hold";
import { type Pool, createLedger } from "./ledger";
import { type CapReason, capMessage, createQuota } from "./quota";
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

export const FREE_PLACEHOLDER_KEY = "retrofit-free";
export const FREE_FAILED_MESSAGE = "The free AI provider did not answer. Try again, or use your own key.";
export const AUTH_MESSAGE = "Retrofit's free AI accepts only its own placeholder key. Your own key goes to your provider, never to Retrofit.";

/** The upstream answer is a short buffered completion (max_tokens 1024); anything larger is refused. */
export const MAX_UPSTREAM_BYTES = 2 * 1024 * 1024;

type ErrorType = "invalid_request_error" | "authentication_error" | "permission_error" | "rate_limit_error" | "server_error" | "service_unavailable";

/** The OpenAI error shape, so the runtime shows `message` in chat. */
function apiError(status: number, message: string, type: ErrorType, code: string): Response {
  return json(status, { error: { message, type, code } });
}

const unavailable = (code = "unavailable") => apiError(503, UNAVAILABLE_MESSAGE, "service_unavailable", code);
const failed = (code: string) => apiError(502, FREE_FAILED_MESSAGE, "server_error", code);
const capped = (reason: CapReason) => apiError(429, capMessage(reason), "rate_limit_error", reason);
const held = () => apiError(429, HOLD_MESSAGE, "rate_limit_error", "free_paused");

type Logger = (event: string, fields?: Record<string, unknown>) => void;

/** Every proxy log line goes through the redaction helper, with the configured secrets. */
function logger(deps: ServerDeps): Logger {
  const f = deps.config.free;
  const secrets = [f.keyPublic, f.keyJudge, f.alertGithubToken, f.cronSecret, f.judgeCode, deps.config.sessionSecret];
  return (event, fields = {}) => console.error(redactText(`free inference: ${event} ${JSON.stringify(redact(fields, secrets))}`, secrets));
}

const describeError = (e: unknown): string => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));

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
async function readAll(body: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<string> {
  const reader = body.getReader();
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason ?? new DOMException("aborted", "AbortError"));
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  aborted.catch(() => {});
  const chunks: Uint8Array[] = [];
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

interface Completion {
  readonly events: unknown[];
  readonly usage: { promptTokens: number; completionTokens: number } | null;
  readonly finished: boolean;
}

const isCount = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/** Parses the SSE text: every `data:` line must be JSON or `[DONE]`; other lines (comments, keep-alives) are dropped. */
function parseStream(text: string): Completion {
  const events: unknown[] = [];
  let usage: Completion["usage"] = null;
  let finished = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
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
    if (typeof e.usage === "object" && e.usage !== null) {
      const u = e.usage as { prompt_tokens?: unknown; completion_tokens?: unknown };
      if (isCount(u.prompt_tokens) && isCount(u.completion_tokens)) usage = { promptTokens: u.prompt_tokens, completionTokens: u.completion_tokens };
    }
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
    return unavailable("not_configured");
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

  const counterDeps = { store: deps.store, config: free, clock: deps.clock };
  const quota = createQuota(counterDeps);
  const ledger = createLedger(counterDeps);
  const hold = createHold(counterDeps);

  let release: (() => Promise<void>) | null = null;
  try {
    // Counters, then the reservation: nothing is forwarded without one.
    let reservationId: string;
    let reservationMicroUsd: number;
    try {
      if (pool === "public" && (await hold.read()) !== null) return held();
      const slot = await quota.acquireInflight(sid);
      if (!slot.ok) return capped(slot.reason);
      release = slot.release;
      const admitted = await quota.admitCall({ sid, pool });
      if (!admitted.ok) return capped(admitted.reason);
      reservationMicroUsd = reservationFor(body, free).microUsd;
      const reserved = await ledger.reserve({ pool, sid, microUsd: reservationMicroUsd });
      if (!reserved.ok) return reserved.reason === "hold" ? held() : capped(reserved.reason);
      reservationId = reserved.reservationId;
    } catch (e) {
      if (!(e instanceof CountersUnavailable)) throw e;
      log("counters unavailable", { error: describeError(e) });
      return unavailable();
    }

    const outcome = await callUpstream(request, deps, serverKey, body, opts.signal);

    if (!outcome.ok) {
      // The provider may already charge for it: keep the full reservation as spend.
      await ledger.reconcile(reservationId, null).catch((e: unknown) => log("reconcile failed", { error: describeError(e) }));
      log("upstream failed", { code: outcome.code, detail: outcome.detail, pool });
      return failed(outcome.code);
    }

    const { completion } = outcome;
    if (!completion.finished || !completion.usage) {
      // Missing usage keeps the full reservation, an upper bound under the stated assumption.
      await ledger.reconcile(reservationId, null).catch((e: unknown) => log("reconcile failed", { error: describeError(e) }));
      const code = completion.finished ? "upstream_no_usage" : "upstream_incomplete";
      log("upstream stream incomplete", { code, pool });
      return failed(code);
    }

    try {
      const result = await ledger.reconcile(reservationId, usageCharge(completion.usage, free));
      if (result.overrun) {
        log("reservation overrun; holding the public pool", { pool, reservationMicroUsd, overrunMicroUsd: result.overrunMicroUsd });
        const alert: OverrunAlert = async () => {
          const record = await hold.read();
          const holdId = String(record ? Date.parse(record.at) : deps.clock());
          await openAlert(overrunAlert(holdId), { config: deps.config, store: deps.store });
        };
        await recordOverrun(counterDeps, result, alert);
      }
    } catch (e) {
      // The answer is complete; the reservation stays outstanding and is charged in full when stale.
      log("reconcile or hold failed after a complete answer", { error: describeError(e) });
    }
    return sseBody(completion.events);
  } catch (e) {
    log("unexpected failure", { error: describeError(e) });
    return unavailable();
  } finally {
    if (release) await release().catch((e: unknown) => log("in-flight release failed", { error: describeError(e) }));
  }
}

type UpstreamOutcome = { ok: true; completion: Completion } | { ok: false; code: string; detail: string };

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
      return { ok: false, code: "upstream_status", detail: `upstream answered ${res.status}` };
    }
    const text = await readAll(res.body, controller.signal);
    return { ok: true, completion: parseStream(text) };
  } catch (e) {
    if (why === "timeout") return { ok: false, code: "upstream_timeout", detail: `no complete answer within ${free.upstreamTimeoutMs} ms` };
    if (why === "disconnect") return { ok: false, code: "visitor_disconnected", detail: "visitor disconnected; upstream aborted" };
    if (e instanceof UpstreamFailure) return { ok: false, code: e.code, detail: e.message };
    return { ok: false, code: "upstream_broken", detail: describeError(e) };
  } finally {
    clearTimeout(timer);
    for (const s of visitorSignals) s.removeEventListener("abort", onDisconnect);
  }
}

/** GET /api/inference/v1/models: only the free model, in the OpenAI list shape. Public: the runtime calls it without credentials. */
export function handleModels(deps: Pick<ServerDeps, "config">): Response {
  return json(200, { object: "list", data: [{ id: deps.config.free.model, object: "model", created: 0, owned_by: "retrofit" }] });
}

export type StatusReason = "no_session" | "not_configured" | "hold" | "unavailable" | "session_calls" | "judge_session_calls" | "public_pool" | "judge_pool" | "ledger";

/**
 * GET /api/inference/status -> 200 `{available, pool, reason}` with no amounts.
 * `reason` is null when available. In fixtures mode only, also `{sid, calls}`
 * for the e2e renewal test. Advisory: the chat route makes the real decision.
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
    const counterDeps = { store: deps.store, config: free, clock: deps.clock };
    const calls = await createQuota(counterDeps).callsUsed(sid);
    const extra = { sid, calls };
    if (!keyFor(deps, pool)) return answer(false, pool, "not_configured", extra);
    const b = await createLedger(counterDeps).budgets();
    if (pool === "public" && (b.held || (await createHold(counterDeps).read()) !== null)) return answer(false, pool, "hold", extra);
    const cap = pool === "judge" ? free.judgeCallsPerSession : free.callsPerSession;
    if (calls >= cap) return answer(false, pool, pool === "judge" ? "judge_session_calls" : "session_calls", extra);
    if (b.remainingCreditMicro <= 0) return answer(false, pool, "ledger", extra);
    if (pool === "public" && b.publicDailyMicro - b.publicSpentTodayMicro <= 0) return answer(false, pool, "public_pool", extra);
    if (pool === "judge" && b.judgeRemainingMicro <= 0) return answer(false, pool, "judge_pool", extra);
    return answer(true, pool, null, extra);
  } catch (e) {
    log("status unavailable", { error: describeError(e) });
    return answer(false, null, "unavailable");
  }
}
