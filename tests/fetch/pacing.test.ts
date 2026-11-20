import { describe, expect, it } from "vitest";
import { CrawlDelayTooLong } from "@/lib/fetch/errors";
import { createPacer, LATE_START_TOLERANCE_MS, MAX_INTERVAL_MS } from "@/lib/fetch/pacing";
import { createMemoryBacking, createMemoryStore } from "@/lib/store/memory";
import type { Store } from "@/lib/store/types";

const START = 1_700_000_000_000;
/** Each slot is measured from its latest allowed start, so back-to-back slots are `interval + P` apart. */
const P = LATE_START_TOLERANCE_MS;

/**
 * Fake clock moved by the test; each pacer sees it plus its own sleeps, so concurrent callers wait
 * independently and a send time is `now + slept`.
 */
function setup(clients = 2) {
  let t = START;
  const clock = () => t;
  const backing = createMemoryBacking();
  const stores: Store[] = Array.from({ length: clients }, () => createMemoryStore({ clock, backing }));
  return {
    clock,
    set: (ms: number) => {
      t = ms;
    },
    stores,
    /** Paces once on a fresh pacer over `store` and returns the time the request would be sent. */
    async sendTime(store: Store, host: string, crawlDelaySeconds?: number): Promise<number> {
      const startedAt = t;
      let slept = 0;
      const pacer = createPacer({
        store,
        clock: () => clock() + slept,
        sleep: async (ms) => {
          slept += ms;
        },
      });
      await pacer.pace(host, crawlDelaySeconds);
      return startedAt + slept;
    },
  };
}

function minGap(times: number[]): number {
  const sorted = [...times].sort((x, y) => x - y);
  let gap = Number.POSITIVE_INFINITY;
  for (let i = 1; i < sorted.length; i++) gap = Math.min(gap, (sorted[i] as number) - (sorted[i - 1] as number));
  return gap;
}

describe("createPacer", () => {
  // Fails if the pacer does not share slots through the store, or does not retry after a compareAndSet conflict
  // (two concurrent callers would get the same slot).
  it("two clients sharing a store never get two slots for one host inside 1 s", async () => {
    const env = setup(2);
    const times = await Promise.all(
      Array.from({ length: 8 }, (_, i) => env.sendTime(env.stores[i % 2] as Store, "bakery.example")),
    );
    expect(times).toHaveLength(8);
    expect(minGap(times)).toBeGreaterThanOrEqual(1000);
    expect(Math.min(...times)).toBe(START);
    expect(Math.max(...times)).toBe(START + 7 * (1000 + P));
  });

  // Fails if the first request for a host is delayed, or a later one after the interval still waits.
  it("does not wait for a first request or after the interval has passed", async () => {
    const env = setup(2);
    expect(await env.sendTime(env.stores[0] as Store, "bakery.example")).toBe(START);
    env.set(START + 400);
    expect(await env.sendTime(env.stores[1] as Store, "bakery.example")).toBe(START + 1000 + P);
    env.set(START + 5000);
    expect(await env.sendTime(env.stores[0] as Store, "bakery.example")).toBe(START + 5000);
  });

  // Fails if the crawl delay is ignored, or if a crawl delay below 1 s shortens the interval.
  it("uses max(1 s, crawl delay) as the interval", async () => {
    const env = setup(2);
    await env.sendTime(env.stores[0] as Store, "slow.example", 5);
    expect(await env.sendTime(env.stores[1] as Store, "slow.example", 5)).toBe(START + 5000 + P);
    await env.sendTime(env.stores[0] as Store, "fast.example", 0.2);
    expect(await env.sendTime(env.stores[1] as Store, "fast.example", 0.2)).toBe(START + 1000 + P);
  });

  // Fails if the slot key is not per host (one host would block another).
  it("distinct hosts do not block each other", async () => {
    const env = setup(2);
    const times = await Promise.all([
      env.sendTime(env.stores[0] as Store, "a.example"),
      env.sendTime(env.stores[1] as Store, "b.example"),
      env.sendTime(env.stores[0] as Store, "c.example"),
    ]);
    expect(times).toEqual([START, START, START]);
  });

  // Fails if the host is not normalized, so a case change would bypass pacing.
  it("treats host names case-insensitively", async () => {
    const env = setup(2);
    await env.sendTime(env.stores[0] as Store, "Bakery.Example");
    expect(await env.sendTime(env.stores[1] as Store, "bakery.example")).toBe(START + 1000 + P);
  });

  // Fails if the slot is not stored under `nextAllowedAt:<host>` as a versioned record.
  it("stores the next allowed time under nextAllowedAt:<host>", async () => {
    const env = setup(1);
    const store = env.stores[0] as Store;
    await env.sendTime(store, "bakery.example");
    await env.sendTime(store, "bakery.example");
    const slot = await store.get<{ version: number; at: number }>("nextAllowedAt:bakery.example");
    expect(slot?.at).toBe(START + 2 * (1000 + P));
    expect(typeof slot?.version).toBe("number");
  });

  // Fails if a slot record that expired and was recreated can be matched by a stale version (ABA),
  // which would hand out a second slot inside the interval.
  it("starts each new slot record at a version that a stale record cannot match", async () => {
    const env = setup(1);
    const store = env.stores[0] as Store;
    await env.sendTime(store, "bakery.example");
    const first = await store.get<{ version: number }>("nextAllowedAt:bakery.example");
    await store.delete("nextAllowedAt:bakery.example");
    env.set(START + 10_000);
    await env.sendTime(store, "bakery.example");
    const second = await store.get<{ version: number }>("nextAllowedAt:bakery.example");
    expect(second?.version).not.toBe(first?.version);
    expect(second?.version).toBeGreaterThan(first?.version as number);
  });

  // Fails if pacing uses a real sleep or real clock when fakes are injected (the test would hang or be wrong),
  // or if the default minimum interval is not 1 s.
  it("waits on the injected sleep for the remaining time", async () => {
    let t = START;
    const sleeps: number[] = [];
    const pacer = createPacer({
      store: createMemoryStore({ clock: () => t }),
      clock: () => t,
      sleep: async (ms) => {
        sleeps.push(ms);
        t += ms;
      },
    });
    await pacer.pace("bakery.example");
    t += 300;
    await pacer.pace("bakery.example");
    expect(sleeps).toEqual([700 + P]);
  });

  // Fails if a crawl delay learned after a request (robots.txt) is measured from the reserved 1 s slot
  // instead of from that request, or is shortened (validation V07).
  it("measures a crawl delay from the previous request's start, without a cap", async () => {
    const env = setup(2);
    // robots.txt: no delay known yet.
    expect(await env.sendTime(env.stores[0] as Store, "slow.example")).toBe(START);
    // The site asked for 30 s: the next request waits the full 30 s from the robots.txt request.
    expect(await env.sendTime(env.stores[1] as Store, "slow.example", 30)).toBe(START + 30_000 + P);
    expect(await env.sendTime(env.stores[0] as Store, "slow.example", 30)).toBe(START + 60_000 + 2 * P);
  });

  // Fails if a wait past the caller's deadline is slept, or if the refused caller still takes the slot.
  it("refuses a slot that starts after notAfter, without waiting or reserving it", async () => {
    let t = START;
    const store = createMemoryStore({ clock: () => t });
    const sleeps: number[] = [];
    const pacer = createPacer({ store, clock: () => t, sleep: async (ms) => void (sleeps.push(ms), (t += ms)) });
    await pacer.pace("slow.example");
    const err = await pacer.pace("slow.example", 40, START + 40_000 + P - 1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CrawlDelayTooLong);
    expect((err as CrawlDelayTooLong).code).toBe("crawl_delay");
    expect(sleeps).toEqual([]);
    // The refused call reserved nothing: a call that fits gets the slot 40 s after the first request's latest start.
    await pacer.pace("slow.example", 40, START + 40_000 + P);
    expect(sleeps).toEqual([40_000 + P]);
  });

  describe("deadline after asynchronous work (validation V07)", () => {
    /** A memory store whose calls advance the shared fake clock by `delays[op]` ms before they run. */
    function slowStore(clock: { now: number }, delays: Partial<Record<"get" | "putIfAbsent" | "compareAndSet", number>>): Store {
      const store = createMemoryStore({ clock: () => clock.now });
      const slow = <A extends unknown[], R>(op: keyof typeof delays, fn: (...a: A) => Promise<R>) => async (...a: A) => {
        clock.now += delays[op] ?? 0;
        return fn(...a);
      };
      return {
        ...store,
        get: slow("get", store.get.bind(store)) as Store["get"],
        putIfAbsent: slow("putIfAbsent", store.putIfAbsent.bind(store)) as Store["putIfAbsent"],
        compareAndSet: slow("compareAndSet", store.compareAndSet.bind(store)) as Store["compareAndSet"],
      };
    }

    // Fails if the slot is calculated from the time read before the store read, so a slow read lets a
    // request start after the deadline.
    it("refuses a slot when its store read ends after notAfter, without reserving it", async () => {
      const clock = { now: START };
      const store = slowStore(clock, { get: 2000 });
      const pacer = createPacer({ store, clock: () => clock.now, sleep: async (ms) => void (clock.now += ms) });
      await expect(pacer.pace("slow-store.example", undefined, START + 1000)).rejects.toBeInstanceOf(CrawlDelayTooLong);
      expect(await store.get("nextAllowedAt:slow-store.example")).toBeNull();
    });

    // Adopted from the validator's reproduction (.local/validation-2141fc4/regressions.test.ts:8).
    // Fails if the deadline is not checked again after the reservation round trip.
    it("does not grant a request slot when its store round trip crosses the crawl deadline", async () => {
      let t = 0;
      const store = createMemoryStore({ clock: () => t });
      const slowPut = {
        ...store,
        async putIfAbsent<T>(key: string, value: T, ttl: number) {
          t += 2000;
          return store.putIfAbsent(key, value, ttl);
        },
      };
      const pacer = createPacer({ store: slowPut, clock: () => t, sleep: async (ms) => void (t += ms) });
      await expect(pacer.pace("example.com", undefined, 1000)).rejects.toBeInstanceOf(CrawlDelayTooLong);
    });

    // Fails if a compareAndSet reservation that returns after the deadline still admits the request, or if
    // the refused caller's reservation is released (the next request would then start inside the interval).
    it("refuses after a reservation that returns past notAfter, and keeps that reservation's spacing", async () => {
      const clock = { now: START };
      const backing = createMemoryBacking();
      const fast = createMemoryStore({ clock: () => clock.now, backing });
      const slow = { ...fast, compareAndSet: (async (...a: Parameters<Store["compareAndSet"]>) => {
        clock.now += 2000;
        return fast.compareAndSet(...a);
      }) as Store["compareAndSet"] };
      const sleeps: number[] = [];
      const sleep = async (ms: number) => void (sleeps.push(ms), (clock.now += ms));
      await createPacer({ store: fast, clock: () => clock.now, sleep }).pace("cas.example");
      // The second slot starts at START + 1000 + P; the reservation returns at START + 2000, after the deadline.
      const err = await createPacer({ store: slow, clock: () => clock.now, sleep }).pace("cas.example", undefined, START + 1500).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CrawlDelayTooLong);
      expect(sleeps).toEqual([]);
      // The refused reservation (latest start START + 1000 + 2P) stays: a 5 s crawl delay is measured from it,
      // not from the first request (START + P), so it can only lengthen the next wait.
      await createPacer({ store: fast, clock: () => clock.now, sleep }).pace("cas.example", 5);
      expect(clock.now).toBe(START + 6000 + 2 * P);
    });

    // Fails if a timer that wakes after the deadline still admits the request.
    it("refuses when the wait's timer wakes after notAfter", async () => {
      let t = START;
      const store = createMemoryStore({ clock: () => t });
      const pacer = createPacer({ store, clock: () => t, sleep: async (ms) => void (t += ms + 5000) });
      await pacer.pace("late-timer.example");
      // The slot starts at START + 1000 + P, inside the deadline, but the timer wakes 5 s late.
      await expect(pacer.pace("late-timer.example", undefined, START + 3000)).rejects.toBeInstanceOf(CrawlDelayTooLong);
    });

    // Fails if the wait is measured from the time before the store calls (a request then starts late by
    // their duration), instead of from the time after the reservation.
    it("computes the remaining wait from the time after the reservation", async () => {
      const clock = { now: START };
      const store = slowStore(clock, { compareAndSet: 300 });
      const sleeps: number[] = [];
      const pacer = createPacer({ store, clock: () => clock.now, sleep: async (ms) => void (sleeps.push(ms), (clock.now += ms)) });
      await pacer.pace("fresh.example");
      clock.now = START;
      await pacer.pace("fresh.example");
      expect(sleeps).toEqual([700 + P]);
      expect(clock.now).toBe(START + 1000 + P);
    });

    // Review F1. Fails if the next slot is measured from the reserved start while a request may start up to
    // LATE_START_TOLERANCE_MS after it: a slow reservation then gives less than the interval between starts.
    it("keeps the full interval between request starts when each reservation takes 200 ms", async () => {
      const clock = { now: START };
      const store = slowStore(clock, { putIfAbsent: 200, compareAndSet: 200 });
      const pacer = createPacer({ store, clock: () => clock.now, sleep: async (ms) => void (clock.now += ms) });
      const starts: number[] = [];
      for (let i = 0; i < 4; i++) {
        await pacer.pace("slow-cas.example", 1);
        starts.push(clock.now);
      }
      expect(minGap(starts)).toBeGreaterThanOrEqual(1000);
    });

    // Fails if a timer that wakes early is trusted, so the request starts before its slot (a shorter Crawl-delay).
    it("waits again when the timer wakes early, so the full crawl delay passes", async () => {
      let t = START;
      const store = createMemoryStore({ clock: () => t });
      const sleeps: number[] = [];
      const pacer = createPacer({ store, clock: () => t, sleep: async (ms) => void (sleeps.push(ms), (t += Math.ceil(ms / 2))) });
      await pacer.pace("early.example");
      await pacer.pace("early.example", 30);
      expect(t).toBeGreaterThanOrEqual(START + 30_000 + P);
      expect(sleeps[0]).toBe(30_000 + P);
      expect(sleeps.length).toBeGreaterThan(1);
    });

    // Fails if a caller that woke long after its slot sends at once, which would start its request less than
    // the interval before the next caller's slot.
    it("takes a new slot when it wakes too late for its own, so the next request keeps the full interval", async () => {
      let t = START;
      const backing = createMemoryBacking();
      const store = () => createMemoryStore({ clock: () => t, backing });
      const sent: Record<string, number> = {};
      const normal = createPacer({ store: store(), clock: () => t, sleep: async (ms) => void (t += ms) });
      await normal.pace("missed.example");
      sent.first = t;
      let lateWake = true;
      const late = createPacer({
        store: store(),
        clock: () => t,
        sleep: async (ms) => {
          if (!lateWake) return void (t += ms);
          lateWake = false;
          // While this caller sleeps for its slot (START + 1000 + P), the timer is held back and another
          // caller takes the next slot (START + 2000 + 2P) and sends.
          t += ms;
          await normal.pace("missed.example");
          sent.other = t;
          t += 500;
        },
      });
      await late.pace("missed.example");
      sent.late = t;
      expect(sent.other).toBe(START + 2000 + 2 * P);
      // Woke 500 ms after the other request, long after its own slot: it does not send then, but takes the
      // slot after the other request's.
      expect(sent.late).toBe(START + 3000 + 3 * P);
      expect((sent.late as number) - (sent.other as number)).toBeGreaterThanOrEqual(1000);
    });
  });

  // Fails if an infinite Crawl-delay (robots-parser gives Infinity for a huge number) reads as no delay (F5).
  it("treats an infinite crawl delay as the longest interval, not as none", async () => {
    let t = START;
    const pacer = createPacer({ store: createMemoryStore({ clock: () => t }), clock: () => t, sleep: async (ms) => void (t += ms) });
    await pacer.pace("huge.example");
    await expect(pacer.pace("huge.example", Number.POSITIVE_INFINITY, START + 3_600_000)).rejects.toBeInstanceOf(CrawlDelayTooLong);
    await expect(pacer.pace("huge.example", 1e300, START + 3_600_000)).rejects.toBeInstanceOf(CrawlDelayTooLong);
  });

  // Fails if a huge delay is written into the slot record (a TTL that overflows the database interval) (F5).
  it("stores at most MAX_INTERVAL_MS ahead, with a bounded TTL", async () => {
    let t = START;
    const backing = createMemoryBacking();
    const pacer = createPacer({ store: createMemoryStore({ clock: () => t, backing }), clock: () => t, sleep: async (ms) => void (t += ms) });
    await pacer.pace("huge.example", 1e300);
    const entry = backing.values.get("nextAllowedAt:huge.example") as { value: { at: number }; expiresAt: number };
    expect(entry.value.at).toBe(START + P + MAX_INTERVAL_MS);
    // The TTL is whole seconds: the interval, the start tolerance rounded up and the one-hour margin.
    expect(entry.expiresAt - START).toBeLessThanOrEqual(MAX_INTERVAL_MS + Math.ceil(P / 1000) * 1000 + 3600 * 1000);
  });
});
