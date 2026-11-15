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
 * Counts `markerKey` once against `counterKey`: the first call puts the marker
 * and only then increments the counter. A refused call removes its marker, so a
 * repeat is refused again rather than passing on the marker.
 */
export async function countOnce(store: Store, markerKey: string, counterKey: string, ttlSeconds: number, limit: number): Promise<boolean> {
  const marker = await store.putIfAbsent(markerKey, 1, ttlSeconds);
  if (!marker.created) return true;
  const count = await store.incrementWindow(counterKey, ttlSeconds);
  if (count > limit) {
    await store.delete(markerKey);
    return false;
  }
  return true;
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
): Promise<LimitResult> {
  const { bucket, endsAt } = clientWindow(now);
  const ok = await countOnce(store, `client-origin:${clientId}:${bucket}:${shortHash(origin)}`, windowKey(clientId, bucket), ttlUntil(endsAt, now), config.analysesPerClientHour);
  return ok ? { ok: true } : { ok: false, retryAt: endsAt };
}
