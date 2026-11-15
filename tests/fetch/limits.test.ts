import { describe, expect, it } from "vitest";
import { COUNT_PENDING_TTL_S, countOnce, DECISION_WAIT_LIMIT_MS } from "@/lib/fetch/limits";
import { createMemoryStore } from "@/lib/store/memory";
import type { Store } from "@/lib/store/types";
import { fakeClock } from "../helpers/server-deps";

const TTL = 3600;

/** A wait clock for countOnce: each sleep moves it forward by the slept time. */
function waitClock() {
  let t = 0;
  let sleeps = 0;
  return {
    opts: { now: () => t, sleep: async (ms: number) => void ((t += ms), sleeps++) },
    advance: (ms: number) => void (t += ms),
    sleeps: () => sleeps,
  };
}

describe("countOnce in-progress decisions", () => {
  // Fails if a duplicate passes, or is reported as refused, while the first caller's decision is
  // still pending (F1: a refusal became a misleading client_limit), or if it waits forever.
  it("answers undecided for a duplicate whose first caller never decides, after a bounded wait", async () => {
    const fc = fakeClock();
    const store = createMemoryStore({ clock: fc.clock });
    // A caller that crashed between placing its marker and deciding.
    await store.putIfAbsent("m", { version: 1, state: "pending" }, COUNT_PENDING_TTL_S);
    const w = waitClock();
    expect(await countOnce(store, "m", "c", TTL, 5, w.opts)).toBe("undecided");
    expect(w.sleeps()).toBeGreaterThan(0);
    // It did not count: the counter was never touched.
    expect(await store.incrementWindow("c", TTL, 0)).toBe(0);
  });

  // Fails if the wait is bounded by attempts instead of elapsed time: slow store calls (Supabase round
  // trips) must not stretch it past DECISION_WAIT_LIMIT_MS or make dozens of calls (F1).
  it("bounds the wait by elapsed time, counting slow store calls", async () => {
    const store = createMemoryStore();
    await store.putIfAbsent("m", { version: 1, state: "pending" }, COUNT_PENDING_TTL_S);
    const w = waitClock();
    let calls = 0;
    const slow: Store = { ...store, putIfAbsent: async (k, v, ttl) => (calls++, w.advance(300), store.putIfAbsent(k, v, ttl)) };
    expect(await countOnce(slow, "m", "c", TTL, 5, w.opts)).toBe("undecided");
    expect(w.opts.now()).toBeLessThanOrEqual(DECISION_WAIT_LIMIT_MS + 300);
    expect(calls).toBeLessThanOrEqual(4);
  });

  // Fails if an abandoned pending marker blocks the origin for the whole window instead of expiring.
  it("decides again once an abandoned pending marker expires", async () => {
    const fc = fakeClock();
    const store = createMemoryStore({ clock: fc.clock });
    await store.putIfAbsent("m", { version: 1, state: "pending" }, COUNT_PENDING_TTL_S);
    fc.advance(COUNT_PENDING_TTL_S * 1000 + 1);
    expect(await countOnce(store, "m", "c", TTL, 5, waitClock().opts)).toBe("admitted");
    // The admitted marker lives for the whole window, not the pending TTL.
    fc.advance(COUNT_PENDING_TTL_S * 1000 + 1);
    expect(await countOnce(store, "m", "c", TTL, 5, waitClock().opts)).toBe("admitted");
    expect(await store.incrementWindow("c", TTL, 0)).toBe(1);
  });

  // Fails if a duplicate that waited does not take the first caller's admitted decision.
  it("a waiting duplicate takes the decision once it is made", async () => {
    const store = createMemoryStore();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const slow = { ...store, incrementWindow: async (key: string, w: number, by?: number) => (await gate, store.incrementWindow(key, w, by)) };
    const first = countOnce(slow, "m", "c", TTL, 5);
    const second = countOnce(store, "m", "c", TTL, 5, { sleep: async () => release() });
    expect(await Promise.all([first, second])).toEqual(["admitted", "admitted"]);
    expect(await store.incrementWindow("c", TTL, 0)).toBe(1);
  });

  // Fails if a duplicate waiting on a first caller that is then refused passes (V04 at an exhausted cap).
  it("a waiting duplicate of a refused first caller is refused too", async () => {
    const store = createMemoryStore();
    await store.incrementWindow("c", TTL, 5);
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const slow = { ...store, incrementWindow: async (key: string, w: number, by?: number) => (await gate, store.incrementWindow(key, w, by)) };
    const first = countOnce(slow, "m", "c", TTL, 5);
    const second = countOnce(store, "m", "c", TTL, 5, { sleep: async () => release() });
    expect(await Promise.all([first, second])).toEqual(["refused", "refused"]);
  });
});
