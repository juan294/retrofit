import { type Clock, type Store, systemClock } from "@/lib/store/types";

/** Stored at `nextAllowedAt:<host>`: the earliest time the next request to the host may start. */
interface Slot {
  readonly version: number;
  readonly at: number;
}

export interface PacerOptions {
  store: Store;
  clock?: Clock;
  sleep?: (ms: number) => Promise<void>;
  minIntervalMs?: number;
}

export interface Pacer {
  /** Resolves when this caller owns the next request slot for `host`. Every request to a host goes through it. */
  pace(host: string, crawlDelaySeconds?: number): Promise<void>;
}

/** Seconds a slot record outlives its `at`, so a slow reader cannot see it vanish and be recreated mid-update. */
const SLOT_TTL_MARGIN_S = 60;
const MAX_ATTEMPTS = 1000;

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createPacer({ store, clock = systemClock, sleep = realSleep, minIntervalMs = 1000 }: PacerOptions): Pacer {
  return {
    async pace(host, crawlDelaySeconds) {
      const key = `nextAllowedAt:${host.toLowerCase()}`;
      const delay = crawlDelaySeconds ?? 0;
      const intervalMs = Math.max(minIntervalMs, Number.isFinite(delay) && delay > 0 ? delay * 1000 : 0);

      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const now = clock();
        const current = await store.get<Slot>(key);
        const slotStart = current ? Math.max(now, current.at) : now;
        // A new record starts at version `now` (ms), above any earlier record's version, so a stale reader
        // of an expired record can never match a recreated one.
        const next: Slot = { version: current ? current.version + 1 : now, at: slotStart + intervalMs };
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
