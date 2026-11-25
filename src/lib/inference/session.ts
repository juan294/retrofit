import { randomBytes } from "node:crypto";
import { isSameOrigin } from "@/lib/analysis/run";
import { formatDate, hhmmUtc } from "@/lib/analysis/texts";
import { isSecureRequest, sameHash } from "@/lib/analysis/visitor";
import { buildCookie, cookieValue } from "@/lib/security/cookies";
import { sha256Hex } from "@/lib/security/tokens";
import { json } from "@/lib/api/json";
import { clientIdFromRequest, clientWindow, nextUtcMidnight, ttlUntil, utcDay } from "@/lib/fetch/limits";
import type { ServerDeps } from "@/lib/server/runtime";
import type { Store } from "@/lib/store/types";
import { JUDGE_SESSION_TTL_MS, judgeCodeTag, SESSION_TTL_MS, sessionTtlMs, signSession, verifySession, type SessionClaims, type SessionPool } from "./token";

/**
 * Free-path sessions (phase-6.md "Sessions"). The cookie carries a signed token;
 * the Store keeps `inference:session:<sid>` `{version, pool, createdAt}`, which
 * is authoritative for the pool. Counters live elsewhere, keyed by sid, so a
 * renewal (same sid) never resets them.
 *
 * A judge session lasts JUDGE_SESSION_TTL_MS from the last visit, so one code entry holds through
 * judging. Its bounds: the judge reserve (the hard cap), a daily call limit per session (quota.ts),
 * a daily count of new judge sessions per network (the code is shared, so a new session must not be
 * a free way around the call limit) and the code itself (a replaced JUDGE_CODE ends its sessions).
 */

export const SESSION_COOKIE = "retrofit_session";
export const SESSION_COOKIE_PATH = "/api/inference";
export const SESSION_TTL_S = SESSION_TTL_MS / 1000;
export const JUDGE_SESSION_TTL_S = JUDGE_SESSION_TTL_MS / 1000;
const MAX_BODY_BYTES = 1024;

export const sessionTexts = {
  crossOrigin: "Open Retrofit at its own address to use the free AI.",
  sessionLimit: "Retrofit's free AI is used up for new sessions from this network this hour. Use your own AI key to continue.",
  unavailable: "Retrofit's free AI is not available right now. Use your own AI key to continue.",
  expired: "Your free session expired. Reload the page.",
  badRequest: "Enter the judge code.",
  invalidCode: "That judge code is not valid.",
  notConfigured: "Judge access is not configured.",
  judgeLimit: (retryAt: Date) => `Judge access was turned on too many times from this network today. Try again after ${hhmmUtc(retryAt)} UTC on ${formatDate(retryAt)}.`,
  judgeUnavailable: "Judge access is not available right now. Try again in a minute.",
  tooManyCodes: "Too many judge code attempts from this network. Try again in an hour.",
} as const;

export interface SessionState {
  readonly version: number;
  readonly pool: SessionPool;
  readonly createdAt: number;
  /** Judge pool only: judgeCodeTag of the code that opened it. */
  readonly judgeTag?: string;
}

export const sessionKey = (sid: string) => `inference:session:${sid}`;
const clientSessionsKey = (client: string, bucket: number) => `inference:client-sessions:${client}:${bucket}`;
const judgeSessionsKey = (client: string, day: string) => `inference:judge-sessions:${client}:${day}`;
const judgeAttemptsKey = (client: string, bucket: number) => `inference:judge-attempts:${client}:${bucket}`;
/** Judge code attempts (right or wrong) allowed per client per hour; more answer 429 before the code is compared. */
export const JUDGE_ATTEMPTS_PER_CLIENT_HOUR = 10;

/** The Store keeps a judge session a day longer than its token, so the token alone decides when it ends. */
const recordTtlS = (pool: SessionPool) => sessionTtlMs(pool) / 1000 + (pool === "judge" ? 86_400 : 0);

export function sessionSetCookie(token: string, pool: SessionPool, secure: boolean): string {
  return buildCookie(SESSION_COOKIE, token, { path: SESSION_COOKIE_PATH, maxAge: sessionTtlMs(pool) / 1000, secure, sameSite: "Strict" });
}

/** The current JUDGE_CODE's tag, or null when judge access is not configured. */
const currentJudgeTag = ({ free, sessionSecret }: ServerDeps["config"]) => (free.judgeCode === null ? null : judgeCodeTag(free.judgeCode, sessionSecret));

const readSessionToken = (request: Request) => cookieValue(request.headers.get("cookie"), SESSION_COOKIE);

/**
 * The request's session: a valid, unexpired cookie whose Store record still
 * exists, and for the judge pool the judge code that opened it is still the code. The pool
 * comes from the Store record, so an upgrade applies to every token of the session. Throws
 * when the Store is unavailable.
 */
export async function readSession(request: Request, deps: Pick<ServerDeps, "config" | "store" | "clock">): Promise<{ claims: SessionClaims } | null> {
  const token = readSessionToken(request);
  if (!token) return null;
  const claims = verifySession(token, deps.config.sessionSecret, deps.clock());
  if (!claims) return null;
  const state = await deps.store.get<SessionState>(sessionKey(claims.sid));
  if (!state || (state.pool === "judge" && state.judgeTag !== currentJudgeTag(deps.config))) return null;
  return { claims: { ...claims, pool: state.pool } };
}

/** Applies `change` with compare-and-set, so a renewal never overwrites a concurrent upgrade. */
async function updateState(store: Store, sid: string, change: (s: SessionState) => Omit<SessionState, "version">): Promise<SessionState | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await store.get<SessionState>(sessionKey(sid));
    if (!current) return null;
    const next: SessionState = { ...change(current), version: current.version + 1 };
    if (await store.compareAndSet(sessionKey(sid), current, next, recordTtlS(next.pool))) return next;
  }
  throw new Error("session record kept changing");
}

function issue(request: Request, deps: ServerDeps, c: Pick<SessionClaims, "sid" | "client" | "pool">): Response {
  const iat = deps.clock();
  const claims: SessionClaims = { ...c, iat, exp: iat + sessionTtlMs(c.pool) };
  const token = signSession(claims, deps.config.sessionSecret);
  return json(200, { pool: claims.pool, expiresAt: new Date(claims.exp).toISOString() }, sessionSetCookie(token, claims.pool, isSecureRequest(request, deps.config)));
}

/** A new session: its Store record and its cookie. */
async function create(request: Request, deps: ServerDeps, client: string, state: Pick<SessionState, "pool" | "judgeTag">): Promise<Response> {
  const sid = randomBytes(16).toString("hex");
  await deps.store.putIfAbsent<SessionState>(sessionKey(sid), { version: 1, createdAt: deps.clock(), ...state }, recordTtlS(state.pool));
  return issue(request, deps, { sid, client, pool: state.pool });
}

const crossOrigin = () => json(403, { error: "cross_origin", message: sessionTexts.crossOrigin });
const unavailable = (message: string) => json(503, { error: "unavailable", message });
const logFailure = (route: string, e: unknown) => console.error(`POST ${route} failed:`, e instanceof Error ? e.message : String(e));

/**
 * POST /api/inference/session -> 200 `{pool, expiresAt}` with the session cookie.
 * Same-origin only (403). A valid cookie is renewed with the same sid, pool and
 * client; otherwise a new public session is created under the per-client hourly
 * cap (429 session_limit), the same with or without an account and a plan. 503 when the Store cannot be read.
 */
export async function handleSession(request: Request, deps: ServerDeps): Promise<Response> {
  if (!isSameOrigin(request, deps.config)) return crossOrigin();
  try {
    const existing = await readSession(request, deps);
    if (existing) {
      const renewed = await updateState(deps.store, existing.claims.sid, (s) => s);
      if (renewed) return issue(request, deps, { sid: existing.claims.sid, client: existing.claims.client, pool: renewed.pool });
    }

    const now = deps.clock();
    const client = clientIdFromRequest(request, deps.config, now);
    const { bucket, endsAt } = clientWindow(now);
    const count = await deps.store.incrementWindow(clientSessionsKey(client, bucket), ttlUntil(endsAt, now));
    if (count > deps.config.free.sessionsPerClientHour) {
      return json(429, { error: "session_limit", message: sessionTexts.sessionLimit, retryAt: new Date(endsAt).toISOString() });
    }
    return await create(request, deps, client, { pool: "public" });
  } catch (e) {
    logFailure("/api/inference/session", e);
    // The signed token names the pool also while the Store cannot be read: no judge is told to bring a key.
    const token = readSessionToken(request);
    const judge = token !== null && verifySession(token, deps.config.sessionSecret, deps.clock())?.pool === "judge";
    return unavailable(judge ? sessionTexts.judgeUnavailable : sessionTexts.unavailable);
  }
}

/** Reads at most MAX_BODY_BYTES; null past that or when the body is not `{code: string}`. Never throws or logs. */
async function readCode(request: Request): Promise<string | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null;
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { code?: unknown } | null;
    return typeof body?.code === "string" ? body.code : null;
  } catch {
    return null;
  }
}

/**
 * POST /api/inference/session/judge `{code}` -> 200 `{pool: "judge", expiresAt}` with the session
 * cookie: the browser's session becomes a judge session with the same sid, or a new judge session is
 * created; a public session is neither needed nor counted. Same-origin only (403); 503 when no judge
 * code is configured; 400 without a string code; 429 too_many_codes past the hourly attempts of the
 * network; 403 for a wrong code (nothing is created); 429 judge_limit past the network's new judge
 * sessions of the UTC day, which a live judge session never counts in again. The code is compared in
 * constant time (equal-length digests) and never logged or echoed.
 */
export async function handleJudgeUpgrade(request: Request, deps: ServerDeps): Promise<Response> {
  if (!isSameOrigin(request, deps.config)) return crossOrigin();
  const expected = deps.config.free.judgeCode;
  if (expected === null) return json(503, { error: "not_configured", message: sessionTexts.notConfigured });
  try {
    const code = await readCode(request);
    if (code === null) return json(400, { error: "bad_request", message: sessionTexts.badRequest });
    // Every attempt counts, atomically and before the compare, so parallel guesses cannot pass the limit.
    const now = deps.clock();
    const client = clientIdFromRequest(request, deps.config, now);
    const attempts = await deps.store.incrementWindow(judgeAttemptsKey(client, clientWindow(now).bucket), 3600);
    if (attempts > JUDGE_ATTEMPTS_PER_CLIENT_HOUR) return json(429, { error: "too_many_codes", message: sessionTexts.tooManyCodes });
    if (!sameHash(sha256Hex(code), sha256Hex(expected))) return json(403, { error: "invalid_code", message: sessionTexts.invalidCode });

    const existing = (await readSession(request, deps))?.claims;
    if (existing?.pool !== "judge") {
      const endsAt = nextUtcMidnight(now);
      const count = await deps.store.incrementWindow(judgeSessionsKey(client, utcDay(now)), ttlUntil(endsAt, now));
      if (count > deps.config.free.judgeSessionsPerClientDay) {
        return json(429, { error: "judge_limit", message: sessionTexts.judgeLimit(new Date(endsAt)), retryAt: new Date(endsAt).toISOString() });
      }
    }
    const judge = { pool: "judge", judgeTag: judgeCodeTag(expected, deps.config.sessionSecret) } as const;
    if (existing && (await updateState(deps.store, existing.sid, (s) => ({ createdAt: s.createdAt, ...judge })))) {
      return issue(request, deps, { sid: existing.sid, client: existing.client, pool: "judge" });
    }
    return await create(request, deps, client, judge);
  } catch (e) {
    logFailure("/api/inference/session/judge", e);
    return unavailable(sessionTexts.judgeUnavailable);
  }
}
