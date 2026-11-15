import { randomBytes } from "node:crypto";
import { isSameOrigin } from "@/lib/analysis/run";
import { hashVisitor, isSecureRequest, sameHash } from "@/lib/analysis/visitor";
import { json } from "@/lib/api/json";
import { clientIdFromRequest, clientWindow, nextUtcMidnight, ttlUntil, utcDay } from "@/lib/fetch/limits";
import type { ServerDeps } from "@/lib/server/runtime";
import type { Store } from "@/lib/store/types";
import { SESSION_TTL_MS, signSession, verifySession, type SessionClaims, type SessionPool } from "./token";

/**
 * Free-path sessions (phase-6.md "Sessions"). The cookie carries a signed token;
 * the Store keeps `inference:session:<sid>` `{version, pool, createdAt}`, which
 * is authoritative for the pool. Counters live elsewhere, keyed by sid, so a
 * renewal (same sid) never resets them.
 */

export const SESSION_COOKIE = "retrofit_session";
export const SESSION_COOKIE_PATH = "/api/inference";
export const SESSION_TTL_S = SESSION_TTL_MS / 1000;
const MAX_BODY_BYTES = 1024;

export const sessionTexts = {
  crossOrigin: "Open Retrofit at its own address to use the free AI.",
  sessionLimit: "Retrofit's free AI is used up for new sessions from this network this hour. Paste your own key in AI settings to continue.",
  unavailable: "Retrofit's free AI is not available right now. Paste your own key in AI settings to continue.",
  expired: "Your free session expired. Reload the page.",
  badRequest: "Enter the judge code.",
  invalidCode: "That judge code is not valid.",
  notConfigured: "Judge access is not configured.",
  judgeLimit: "Judge access is used up for this network today. Paste your own key in AI settings to continue.",
  tooManyCodes: "Too many judge code attempts from this network. Try again in an hour.",
} as const;

export interface SessionState {
  readonly version: number;
  readonly pool: SessionPool;
  readonly createdAt: number;
}

export const sessionKey = (sid: string) => `inference:session:${sid}`;
const clientSessionsKey = (client: string, bucket: number) => `inference:client-sessions:${client}:${bucket}`;
const judgeSessionsKey = (client: string, day: string) => `inference:judge-sessions:${client}:${day}`;
const judgeAttemptsKey = (client: string, bucket: number) => `inference:judge-attempts:${client}:${bucket}`;
/** Judge code attempts (right or wrong) allowed per client per hour; more answer 429 before the code is compared. */
export const JUDGE_ATTEMPTS_PER_CLIENT_HOUR = 10;

export function sessionSetCookie(token: string, secure: boolean): string {
  const attrs = [`${SESSION_COOKIE}=${token}`, "HttpOnly", "SameSite=Strict", `Path=${SESSION_COOKIE_PATH}`, `Max-Age=${SESSION_TTL_S}`];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

function readSessionToken(request: Request): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq !== -1 && part.slice(0, eq).trim() === SESSION_COOKIE) return part.slice(eq + 1).trim();
  }
  return null;
}

/**
 * The request's session: a valid, unexpired cookie whose Store record still
 * exists. The pool comes from the Store record, so an upgrade applies to every
 * token of the session. Throws when the Store is unavailable.
 */
export async function readSession(request: Request, deps: Pick<ServerDeps, "config" | "store" | "clock">): Promise<{ claims: SessionClaims } | null> {
  const token = readSessionToken(request);
  if (!token) return null;
  const claims = verifySession(token, deps.config.sessionSecret, deps.clock());
  if (!claims) return null;
  const state = await deps.store.get<SessionState>(sessionKey(claims.sid));
  if (!state) return null;
  return { claims: { ...claims, pool: state.pool } };
}

/** Applies `change` with compare-and-set, so a renewal never overwrites a concurrent upgrade. */
async function updateState(store: Store, sid: string, change: (s: SessionState) => Omit<SessionState, "version">): Promise<SessionState | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await store.get<SessionState>(sessionKey(sid));
    if (!current) return null;
    const next: SessionState = { ...change(current), version: current.version + 1 };
    if (await store.compareAndSet(sessionKey(sid), current, next, SESSION_TTL_S)) return next;
  }
  throw new Error("session record kept changing");
}

function issue(request: Request, deps: ServerDeps, c: Pick<SessionClaims, "sid" | "client" | "pool">): Response {
  const iat = deps.clock();
  const claims: SessionClaims = { ...c, iat, exp: iat + SESSION_TTL_MS };
  const token = signSession(claims, deps.config.sessionSecret);
  return json(200, { pool: claims.pool, expiresAt: new Date(claims.exp).toISOString() }, sessionSetCookie(token, isSecureRequest(request, deps.config)));
}

const crossOrigin = () => json(403, { error: "cross_origin", message: sessionTexts.crossOrigin });
const unavailable = () => json(503, { error: "unavailable", message: sessionTexts.unavailable });
const logFailure = (route: string, e: unknown) => console.error(`POST ${route} failed:`, e instanceof Error ? e.message : String(e));

/**
 * POST /api/inference/session -> 200 `{pool, expiresAt}` with the session cookie.
 * Same-origin only (403). A valid cookie is renewed with the same sid, pool and
 * client; otherwise a new public session is created under the per-client hourly
 * cap (429 session_limit). 503 when the Store is unavailable.
 */
export async function handleSession(request: Request, deps: ServerDeps): Promise<Response> {
  if (!isSameOrigin(request, deps.config)) return crossOrigin();
  try {
    const existing = await readSession(request, deps);
    if (existing) {
      const renewed = await updateState(deps.store, existing.claims.sid, (s) => ({ pool: s.pool, createdAt: s.createdAt }));
      if (renewed) return issue(request, deps, { sid: existing.claims.sid, client: existing.claims.client, pool: renewed.pool });
    }

    const now = deps.clock();
    const client = clientIdFromRequest(request, deps.config, now);
    const { bucket, endsAt } = clientWindow(now);
    const count = await deps.store.incrementWindow(clientSessionsKey(client, bucket), ttlUntil(endsAt, now));
    if (count > deps.config.free.sessionsPerClientHour) {
      return json(429, { error: "session_limit", message: sessionTexts.sessionLimit, retryAt: new Date(endsAt).toISOString() });
    }
    const sid = randomBytes(16).toString("hex");
    await deps.store.putIfAbsent<SessionState>(sessionKey(sid), { version: 1, pool: "public", createdAt: now }, SESSION_TTL_S);
    return issue(request, deps, { sid, client, pool: "public" });
  } catch (e) {
    logFailure("/api/inference/session", e);
    return unavailable();
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
 * POST /api/inference/session/judge `{code}` -> 200 `{pool: "judge", expiresAt}`
 * with a new cookie for the same sid. Same-origin only (403); 503 when no judge
 * code is configured; 401 without a valid session; 400 without a string code;
 * 403 for a wrong code; 429 judge_limit past the per-client daily cap. The code
 * is compared in constant time (equal-length digests) and never logged or echoed.
 */
export async function handleJudgeUpgrade(request: Request, deps: ServerDeps): Promise<Response> {
  if (!isSameOrigin(request, deps.config)) return crossOrigin();
  const expected = deps.config.free.judgeCode;
  if (expected === null) return json(503, { error: "not_configured", message: sessionTexts.notConfigured });
  try {
    const session = await readSession(request, deps);
    if (!session) return json(401, { error: "session_expired", message: sessionTexts.expired });
    const code = await readCode(request);
    if (code === null) return json(400, { error: "bad_request", message: sessionTexts.badRequest });
    // Every attempt counts, atomically and before the compare, so parallel guesses cannot pass the limit.
    const now0 = deps.clock();
    const requester0 = clientIdFromRequest(request, deps.config, now0);
    const attempts = await deps.store.incrementWindow(judgeAttemptsKey(requester0, Math.floor(now0 / 3_600_000)), 3600);
    if (attempts > JUDGE_ATTEMPTS_PER_CLIENT_HOUR) return json(429, { error: "too_many_codes", message: sessionTexts.tooManyCodes });
    if (!sameHash(hashVisitor(code), hashVisitor(expected))) return json(403, { error: "invalid_code", message: sessionTexts.invalidCode });

    const { sid, client } = session.claims;
    if (session.claims.pool !== "judge") {
      const now = deps.clock();
      const day = utcDay(now);
      const endsAt = nextUtcMidnight(now);
      const requester = clientIdFromRequest(request, deps.config, now);
      const count = await deps.store.incrementWindow(judgeSessionsKey(requester, day), ttlUntil(endsAt, now));
      if (count > deps.config.free.judgeSessionsPerClientDay) {
        return json(429, { error: "judge_limit", message: sessionTexts.judgeLimit, retryAt: new Date(endsAt).toISOString() });
      }
    }
    const upgraded = await updateState(deps.store, sid, (s) => ({ pool: "judge", createdAt: s.createdAt }));
    if (!upgraded) return json(401, { error: "session_expired", message: sessionTexts.expired });
    return issue(request, deps, { sid, client, pool: "judge" });
  } catch (e) {
    logFailure("/api/inference/session/judge", e);
    return unavailable();
  }
}
