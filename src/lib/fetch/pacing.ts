import { type Clock, type Store, systemClock } from "@/lib/store/types";
import { CrawlDelayTooLong } from "./errors";

/**
 * Stored at `nextAllowedAt:<host>`: `at` is the earliest time the next request
 * to the host may start; `last` is the latest time the latest request may
 * start (its slot start plus LATE_START_TOLERANCE_MS), so a crawl delay
 * learned after that request (from robots.txt) is measured from it.
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
  /** Latest start after a slot's start. Default LATE_START_TOLERANCE_MS; tests with a tiny interval lower it. */
  lateStartToleranceMs?: number;
}

export interface Pacer {
  /**
   * Resolves when this caller owns the next request slot for `host` and the
   * slot has started. Every request to a host goes through it. The interval is
   * max(minimum interval, crawl delay), up to MAX_INTERVAL_MS (one day).
   *
   * With `notAfter` (ms), it never resolves after that time: the clock is read
   * again after every store call and every wait, so a slow store or a late
   * timer cannot admit a request after the deadline. A slot that would start
   * after `notAfter` throws CrawlDelayTooLong without waiting or taking the
   * slot; a deadline that passes after the slot was taken throws it too.
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
/**
 * Latest a caller may start after its slot's start. A slot stores its start
 * plus this tolerance as `last`, and the next slot starts at least one
 * interval after `last`, so the gap between actual request starts is never
 * shorter than the interval. A caller that would start later (a held-back
 * timer or a slow reservation) takes a new slot instead of sending.
 */
export const LATE_START_TOLERANCE_MS = 250;
const MAX_ATTEMPTS = 1000;

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createPacer({
  store,
  clock = systemClock,
  sleep = realSleep,
  minIntervalMs = 1000,
  lateStartToleranceMs = LATE_START_TOLERANCE_MS,
}: PacerOptions): Pacer {
  return {
    async pace(host, crawlDelaySeconds, notAfter) {
      const key = `nextAllowedAt:${host.toLowerCase()}`;
      const delay = crawlDelaySeconds ?? 0;
      // NaN or a non-positive delay asks for nothing; Infinity asks for the longest interval.
      const requestedMs = delay > 0 ? Math.min(delay * 1000, MAX_INTERVAL_MS) : 0;
      const intervalMs = Math.max(minIntervalMs, requestedMs);
      const tooLate = (t: number) => notAfter !== undefined && t > notAfter;

      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const current = await store.get<Slot>(key);
        // Time is read after each store call and wait below, never before it.
        let now = clock();
        const slotStart = current ? Math.max(now, current.at, (current.last ?? Number.NEGATIVE_INFINITY) + intervalMs) : now;
        if (tooLate(slotStart)) throw new CrawlDelayTooLong(host, slotStart - now);
        // A new record starts at version `now` (ms), above any earlier record's version, so a stale reader
        // of an expired record can never match a recreated one.
        const latestStart = slotStart + lateStartToleranceMs;
        const next: Slot = { version: current ? current.version + 1 : now, at: latestStart + intervalMs, last: latestStart };
        const ttlSeconds = Math.ceil((next.at - now) / 1000) + SLOT_TTL_MARGIN_S;

        const won = current
          ? await store.compareAndSet(key, current, next, ttlSeconds)
          : (await store.putIfAbsent(key, next, ttlSeconds)).created;
        if (!won) continue;

        // The slot is ours. Wait for its start from fresh time; a timer that wakes early waits again.
        for (now = clock(); now < slotStart; now = clock()) await sleep(slotStart - now);
        // A deadline that passed during the reservation or the wait refuses the request. The reservation
        // stays: it only makes the next request to this host wait longer. Undoing it would need another
        // conditional write after the deadline, and an unconditional delete could erase a later caller's
        // slot and shorten its spacing.
        if (tooLate(now)) throw new CrawlDelayTooLong(host, 0);
        if (now <= latestStart) return;
        // Too late for this slot: the next caller may start one interval after its `last`. Take a new
        // slot, spaced from this one and from any later caller's.
      }
      throw new Error(`pacing for ${host} did not get a slot after ${MAX_ATTEMPTS} attempts`);
    },
  };
}
