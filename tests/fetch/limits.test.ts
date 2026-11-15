import { describe, expect, it } from "vitest";
import { COUNT_PENDING_TTL_S, countOnce } from "@/lib/fetch/limits";
import { createMemoryStore } from "@/lib/store/memory";
import { fakeClock } from "../helpers/server-deps";

const TTL = 3600;

describe("countOnce in-progress decisions", () => {
  // Fails if a duplicate passes while the first caller's decision is still pending, or waits forever.
  it("refuses a duplicate whose first caller never decides, after a bounded wait", async () => {
    const fc = fakeClock();
    const store = createMemoryStore({ clock: fc.clock });
    // A caller that crashed between placing its marker and deciding.
    await store.putIfAbsent("m", { version: 1, state: "pending" }, COUNT_PENDING_TTL_S);
    let waits = 0;
    const allowed = await countOnce(store, "m", "c", TTL, 5, async () => void waits++);
    expect(allowed).toBe(false);
    expect(waits).toBeGreaterThan(0);
    // It did not count: the counter was never touched.
    expect(await store.incrementWindow("c", TTL, 0)).toBe(0);
  });

  // Fails if an abandoned pending marker blocks the origin for the whole window instead of expiring.
  it("decides again once an abandoned pending marker expires", async () => {
    const fc = fakeClock();
    const store = createMemoryStore({ clock: fc.clock });
    await store.putIfAbsent("m", { version: 1, state: "pending" }, COUNT_PENDING_TTL_S);
    fc.advance(COUNT_PENDING_TTL_S * 1000 + 1);
    expect(await countOnce(store, "m", "c", TTL, 5, async () => {})).toBe(true);
    // The admitted marker lives for the whole window, not the pending TTL.
    fc.advance(COUNT_PENDING_TTL_S * 1000 + 1);
    expect(await countOnce(store, "m", "c", TTL, 5, async () => {})).toBe(true);
    expect(await store.incrementWindow("c", TTL, 0)).toBe(1);
  });

  // Fails if a duplicate that waited does not take the first caller's admitted decision.
  it("a waiting duplicate takes the decision once it is made", async () => {
    const store = createMemoryStore();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const slow = { ...store, incrementWindow: async (key: string, w: number, by?: number) => (await gate, store.incrementWindow(key, w, by)) };
    const first = countOnce(slow, "m", "c", TTL, 5);
    const second = countOnce(store, "m", "c", TTL, 5, async () => release());
    expect(await Promise.all([first, second])).toEqual([true, true]);
    expect(await store.incrementWindow("c", TTL, 0)).toBe(1);
  });
});
