import { describe, expect, it } from "vitest";
import { createPacer } from "@/lib/fetch/pacing";
import { createMemoryBacking, createMemoryStore } from "@/lib/store/memory";
import type { Store } from "@/lib/store/types";

const START = 1_700_000_000_000;

/** Fixed fake clock; each pacer gets its own sleep recorder so a send time is `now + slept`. */
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
        clock,
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
    expect(Math.max(...times)).toBe(START + 7000);
  });

  // Fails if the first request for a host is delayed, or a later one after the interval still waits.
  it("does not wait for a first request or after the interval has passed", async () => {
    const env = setup(2);
    expect(await env.sendTime(env.stores[0] as Store, "bakery.example")).toBe(START);
    env.set(START + 400);
    expect(await env.sendTime(env.stores[1] as Store, "bakery.example")).toBe(START + 1000);
    env.set(START + 5000);
    expect(await env.sendTime(env.stores[0] as Store, "bakery.example")).toBe(START + 5000);
  });

  // Fails if the crawl delay is ignored, or if a crawl delay below 1 s shortens the interval.
  it("uses max(1 s, crawl delay) as the interval", async () => {
    const env = setup(2);
    await env.sendTime(env.stores[0] as Store, "slow.example", 5);
    expect(await env.sendTime(env.stores[1] as Store, "slow.example", 5)).toBe(START + 5000);
    await env.sendTime(env.stores[0] as Store, "fast.example", 0.2);
    expect(await env.sendTime(env.stores[1] as Store, "fast.example", 0.2)).toBe(START + 1000);
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
    expect(await env.sendTime(env.stores[1] as Store, "bakery.example")).toBe(START + 1000);
  });

  // Fails if the slot is not stored under `nextAllowedAt:<host>` as a versioned record.
  it("stores the next allowed time under nextAllowedAt:<host>", async () => {
    const env = setup(1);
    const store = env.stores[0] as Store;
    await env.sendTime(store, "bakery.example");
    await env.sendTime(store, "bakery.example");
    const slot = await store.get<{ version: number; at: number }>("nextAllowedAt:bakery.example");
    expect(slot?.at).toBe(START + 2000);
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
    expect(sleeps).toEqual([700]);
  });
});
