import { createHash, createHmac } from "node:crypto";
import type { Config } from "@/lib/config";
import type { Store } from "@/lib/store/types";

/**
 * Per-client limits. A client is identified by SHA-256 of its IP address and a
 * daily salt derived from SESSION_SECRET. The raw IP is never stored, logged
 * or returned; only the hash reaches the Store.
 */

export const CLIENT_WINDOW_S = 3600;
const HOUR_MS = CLIENT_WINDOW_S * 1000;

/** UTC date, `YYYY-MM-DD`. */
export function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** 00:00 UTC after `now`, in ms. */
export function nextUtcMidnight(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

export function dailySalt(secret: string, now: number): string {
  return createHmac("sha256", secret).update(`retrofit-client-salt:${utcDay(now)}`).digest("hex");
}

export function clientIdFor(ip: string, config: Pick<Config, "sessionSecret">, now: number): string {
  return createHash("sha256").update(`${ip}\n${dailySalt(config.sessionSecret, now)}`).digest("hex");
}

/**
 * The client's IP as the platform reports it. On Vercel, `x-real-ip` and the
 * first `x-forwarded-for` entry are set by the platform (INFERRED from Vercel's
 * header documentation; verify in Phase 7). Without either, every caller shares
 * one "unknown" client, which is the safe direction for a limit.
 */
export function clientIpFrom(request: Request): string {
  const real = request.headers.get("x-real-ip")?.trim();
  if (real) return real;
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || "unknown";
}

export function clientIdFromRequest(request: Request, config: Pick<Config, "sessionSecret">, now: number): string {
  return clientIdFor(clientIpFrom(request), config, now);
}

/** Fixed one-hour windows aligned to the hour, so the retry time is known. */
export function clientWindow(now: number): { bucket: number; endsAt: number } {
  const bucket = Math.floor(now / HOUR_MS);
  return { bucket, endsAt: (bucket + 1) * HOUR_MS };
}

export type LimitResult = { readonly ok: true } | { readonly ok: false; readonly retryAt: number };

const windowKey = (clientId: string, bucket: number) => `client-window:${clientId}:${bucket}`;

/** Counts one analysis (visitor route): every call counts. */
export async function countClientAnalysis(store: Store, config: Pick<Config, "analysesPerClientHour">, clientId: string, now: number): Promise<LimitResult> {
  const { bucket, endsAt } = clientWindow(now);
  const count = await store.incrementWindow(windowKey(clientId, bucket), ttlUntil(endsAt, now));
  return count > config.analysesPerClientHour ? { ok: false, retryAt: endsAt } : { ok: true };
}

/**
 * A count-once marker. `pending` while its first caller decides; `counted`
 * once the counter admitted it. A refused marker is deleted, never stored.
 */
interface CountMarker {
  readonly version: number;
  readonly state: "pending" | "counted";
}

/** A pending marker lives this long (at most), so a caller that crashed before deciding blocks nobody for long. */
export const COUNT_PENDING_TTL_S = 10;
const DECISION_WAIT_MS = 50;
/** Longest real time a duplicate waits for another caller's decision, store round trips included. */
export const DECISION_WAIT_LIMIT_MS = 1000;

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** `undecided`: another caller for the same marker had not decided within DECISION_WAIT_LIMIT_MS. */
export type CountDecision = "admitted" | "refused" | "undecided";

export interface CountOnceOptions {
  /** Waits between reads of a pending marker. Default: a timer. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Real-time clock (ms) for the wait limit. Default: Date.now. */
  readonly now?: () => number;
}

/**
 * Counts `markerKey` once against `counterKey` and decides whether the
 * counter admits it (count <= limit).
 *
 * The first caller puts a `pending` marker, increments the counter and then
 * either marks it `counted` (admitted) or deletes it (refused). Only a
 * `counted` marker lets a repeat pass without counting. A caller that finds a
 * `pending` marker waits for that decision: `counted` admits it; a deleted
 * marker makes it decide for itself, so a refused first caller's duplicate is
 * refused too. When no decision comes within DECISION_WAIT_LIMIT_MS of real
 * time (store calls included), the answer is `undecided`: neither admitted
 * nor counted, and the caller chooses a short retry. The pending marker
 * expires after COUNT_PENDING_TTL_S.
 */
export async function countOnce(
  store: Store,
  markerKey: string,
  counterKey: string,
  ttlSeconds: number,
  limit: number,
  opts: CountOnceOptions = {},
): Promise<CountDecision> {
  const sleep = opts.sleep ?? realSleep;
  const now = opts.now ?? Date.now;
  const giveUpAt = now() + DECISION_WAIT_LIMIT_MS;
  const pending: CountMarker = { version: 1, state: "pending" };
  for (;;) {
    const marker = await store.putIfAbsent<CountMarker>(markerKey, pending, Math.min(ttlSeconds, COUNT_PENDING_TTL_S));
    if (marker.created) {
      const count = await store.incrementWindow(counterKey, ttlSeconds);
      if (count > limit) {
        await store.delete(markerKey);
        return "refused";
      }
      // The counter admitted it. A lost compareAndSet means the pending marker expired first;
      // the admission stands.
      await store.compareAndSet<CountMarker>(markerKey, pending, { version: 2, state: "counted" }, ttlSeconds);
      return "admitted";
    }
    if (marker.value?.state === "counted") return "admitted";
    if (now() + DECISION_WAIT_MS > giveUpAt) return "undecided";
    await sleep(DECISION_WAIT_MS);
  }
}

export const shortHash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 32);
export const ttlUntil = (endsAt: number, now: number) => Math.max(1, Math.ceil((endsAt - now) / 1000));

/**
 * Counts one origin for the score API (contract validation rule 6): repeat
 * requests for the same origin by the same client in the same window do not
 * count, so polling a running score never uses up the limit.
 */
export async function countClientOrigin(
  store: Store,
  config: Pick<Config, "analysesPerClientHour">,
  clientId: string,
  origin: string,
  now: number,
): Promise<LimitResult | { readonly ok: false; readonly undecided: true }> {
  const { bucket, endsAt } = clientWindow(now);
  const decision = await countOnce(store, clientOriginMarker(clientId, bucket, origin), windowKey(clientId, bucket), ttlUntil(endsAt, now), config.analysesPerClientHour);
  if (decision === "undecided") return { ok: false, undecided: true };
  return decision === "admitted" ? { ok: true } : { ok: false, retryAt: endsAt };
}

/** The count-once marker of one origin for one client in one window. */
export const clientOriginMarker = (clientId: string, bucket: number, origin: string) => `client-origin:${clientId}:${bucket}:${shortHash(origin)}`;
