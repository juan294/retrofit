import { describe, expect, it } from "vitest";
import { countReads } from "@/lib/store/counting";
import { createMemoryStore } from "@/lib/store/memory";

describe("countReads", () => {
  // Fails if filtered reads are miscounted, or if writes and lease/queue operations go uncounted
  // (the status route's total store work would then be under-reported, validation V16).
  it("counts filtered reads and every store operation", async () => {
    const counted = countReads(createMemoryStore(), (key) => key.startsWith("analysis:"));
    const s = counted.store;
    await s.get("analysis:1");
    await s.get("other:1");
    await s.set("analysis:1", { version: 1 }, 60);
    await s.compareAndSet("analysis:1", { version: 1 }, { version: 2 }, 60);
    await s.claimWithLease("q", ["slot:0"], 60);
    await s.enqueue("q", "x", 60);
    await s.claimWithLease("q", ["slot:0"], 60);
    expect(counted.reads()).toBe(1);
    expect(counted.operations()).toBe(7);
    expect(counted.byOperation()).toEqual({ get: 2, set: 1, compareAndSet: 1, claimWithLease: 2, enqueue: 1 });
  });

  // Fails if the wrapper changes results or loses `this` for the wrapped store's methods.
  it("returns the wrapped store's results", async () => {
    const counted = countReads(createMemoryStore());
    await counted.store.set("k", 7, 60);
    expect(await counted.store.get("k")).toBe(7);
    expect(await counted.store.putIfAbsent("k", 8, 60)).toEqual({ created: false, value: 7 });
  });
});
