import { type Clock, type Store, systemClock } from "@/lib/store/types";
import { CrawlDelayTooLong } from "./errors";

/**
 * Stored at `nextAllowedAt:<host>`: `at` is the earliest time the next request
 * to the host may start; `last` is when the latest request started, so a crawl
 * delay learned after that request (from robots.txt) is measured from it.
 */
interface Slot {
  readonly version: number;
  readonly at: number;
  readonly last?: number;
}

export interface PacerOptions {
  store: Store;
  clock?: Clock;
  sleep?: (ms: number) => Promise<void>;
  minIntervalMs?: number;
}

export interface Pacer {
  /**
   * Resolves when this caller owns the next request slot for `host`. Every
   * request to a host goes through it. The interval is max(minimum interval,
   * crawl delay), up to MAX_INTERVAL_MS (one day). When the slot would start after
   * `notAfter` (ms), throws CrawlDelayTooLong at once, without waiting or
   * taking the slot.
   */
  pace(host: string, crawlDelaySeconds?: number, notAfter?: number): Promise<void>;
}

/**
 * Seconds a slot record outlives its `at`. A slow reader cannot see it vanish
 * and be recreated mid-update, and `last` survives as long as a cached robots
 * record (ROBOTS_TTL_S, one hour), so a long crawl delay read from that record
 * is still measured from the host's latest request.
 */
const SLOT_TTL_MARGIN_S = 3600;
/**
 * Longest interval the pacer applies and stores: one day. A crawl never makes
 * two requests to a host that far apart (its budget is under a minute), so a
 * longer Crawl-delay (robots-parser returns up to Infinity) only refuses the
 * next request, and the stored slot and its TTL stay finite and small.
 */
export const MAX_INTERVAL_MS = 24 * 3600 * 1000;
const MAX_ATTEMPTS = 1000;

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createPacer({ store, clock = systemClock, sleep = realSleep, minIntervalMs = 1000 }: PacerOptions): Pacer {
  return {
    async pace(host, crawlDelaySeconds, notAfter) {
      const key = `nextAllowedAt:${host.toLowerCase()}`;
      const delay = crawlDelaySeconds ?? 0;
      // NaN or a non-positive delay asks for nothing; Infinity asks for the longest interval.
      const requestedMs = delay > 0 ? Math.min(delay * 1000, MAX_INTERVAL_MS) : 0;
      const intervalMs = Math.max(minIntervalMs, requestedMs);

      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const now = clock();
        const current = await store.get<Slot>(key);
        const slotStart = current ? Math.max(now, current.at, (current.last ?? Number.NEGATIVE_INFINITY) + intervalMs) : now;
        if (notAfter !== undefined && slotStart > notAfter) throw new CrawlDelayTooLong(host, slotStart - now);
        // A new record starts at version `now` (ms), above any earlier record's version, so a stale reader
        // of an expired record can never match a recreated one.
        const next: Slot = { version: current ? current.version + 1 : now, at: slotStart + intervalMs, last: slotStart };
        const ttlSeconds = Math.ceil((next.at - now) / 1000) + SLOT_TTL_MARGIN_S;

        const won = current
          ? await store.compareAndSet(key, current, next, ttlSeconds)
          : (await store.putIfAbsent(key, next, ttlSeconds)).created;
        if (!won) continue;

        if (slotStart > now) await sleep(slotStart - now);
        return;
      }
      throw new Error(`pacing for ${host} did not get a slot after ${MAX_ATTEMPTS} attempts`);
    },
  };
}
