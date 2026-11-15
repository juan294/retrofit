import { describe, expect, it } from "vitest";
import { createMemoryBacking, createMemoryStore } from "@/lib/store/memory";
import { fakeClock } from "../helpers/server-deps";
import { runStoreContract } from "./contract";

runStoreContract("memory (two clients, one backing)", async () => {
  const clock = fakeClock(1_700_000_000_000);
  const backing = createMemoryBacking();
  return {
    a: createMemoryStore({ clock: clock.now, backing }),
    b: createMemoryStore({ clock: clock.now, backing }),
    clock,
    cleanup: async () => {},
  };
});

describe("memory store specifics", () => {
  // Fails if a store without an explicit backing shares state with other stores.
  it("stores without a shared backing are isolated", async () => {
    const a = createMemoryStore();
    const b = createMemoryStore();
    await a.set("k", 1, 60);
    expect(await b.get("k")).toBeNull();
  });

  // Fails if instrument is not called once per operation with the operation name and key.
  it("reports each operation to instrument", async () => {
    const calls: Array<[string, string]> = [];
    const store = createMemoryStore({ instrument: (op, key) => calls.push([op, key]) });
    await store.set("k", 1, 60);
    await store.get("k");
    await store.get("k");
    await store.claimNext("q");
    expect(calls).toEqual([
      ["set", "k"],
      ["get", "k"],
      ["get", "k"],
      ["claimNext", "q"],
    ]);
  });

  // Fails if claimNext skips expired entries but leaves them in the backing (unbounded growth).
  it("claimNext removes expired entries from the backing", async () => {
    const clock = fakeClock(1_700_000_000_000);
    const backing = createMemoryBacking();
    const store = createMemoryStore({ clock: clock.now, backing });
    await store.enqueue("q", "x", 1);
    await store.enqueue("q", "y", 1);
    clock.advance(1001);
    expect(await store.claimNext("q")).toBeNull();
    expect(backing.queues.get("q") ?? []).toHaveLength(0);
  });

  // Fails if an operation writes synchronously before its first await (callers would never interleave, hiding atomicity bugs).
  it("operations do not touch the backing before yielding", async () => {
    const backing = createMemoryBacking();
    const store = createMemoryStore({ backing });
    const pending = store.set("k", 1, 60);
    expect(backing.values.has("k")).toBe(false);
    await pending;
    expect(backing.values.has("k")).toBe(true);
  });
});
