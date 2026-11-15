/**
 * Shared Store contract suite. The memory adapter runs it in `tests/store/memory.test.ts`;
 * Phase 7 runs it against Supabase with a real clock.
 *
 * Time rules, so a real clock can drive it:
 * - Short TTLs are 1 or 2 seconds; `advance` may sleep for real.
 * - Every "still live" check either uses a long TTL or leaves at least 900 ms of margin.
 * - Every key is prefixed with a per-test random namespace, so runs never collide in a shared database.
 */
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { countOnce } from "@/lib/fetch/limits";
import type { Store, Versioned } from "@/lib/store/types";

export interface ContractClock {
  now(): number;
  /** Moves time forward by at least `ms`. A real-clock implementation sleeps. */
  advance(ms: number): void | Promise<void>;
}

export interface ContractClients {
  a: Store;
  b: Store;
  clock: ContractClock;
  cleanup(): Promise<void>;
}

const LONG_TTL = 600;
/** Past a 1 s TTL with margin for a real clock. */
const PAST_ONE_SECOND = 1100;

interface Doc extends Versioned {
  readonly body: string;
}

export function runStoreContract(name: string, makeClients: () => Promise<ContractClients>): void {
  describe(`Store contract: ${name}`, () => {
    let a: Store;
    let b: Store;
    let clock: ContractClock;
    let cleanup: () => Promise<void>;
    let ns: string;
    const k = (key: string) => `${ns}:${key}`;

    beforeEach(async () => {
      ({ a, b, clock, cleanup } = await makeClients());
      ns = `contract-${randomUUID()}`;
    });

    afterEach(async () => {
      await cleanup();
    });

    describe("get, set, delete", () => {
      // Fails if set does not write through to the shared backing (client b would read null).
      it("a value written by one client is read by the other", async () => {
        await a.set(k("v"), { n: 1 }, LONG_TTL);
        expect(await b.get(k("v"))).toEqual({ n: 1 });
      });

      // Fails if get ignores the expiry time.
      it("get returns null after the TTL and the value before it", async () => {
        await a.set(k("v"), "x", 2);
        await clock.advance(1000);
        expect(await b.get(k("v"))).toBe("x");
        await clock.advance(PAST_ONE_SECOND);
        expect(await b.get(k("v"))).toBeNull();
      });

      // Fails if delete is a no-op or only clears one client's view.
      it("delete removes the value for both clients", async () => {
        await a.set(k("v"), "x", LONG_TTL);
        await b.delete(k("v"));
        expect(await a.get(k("v"))).toBeNull();
      });

      // Fails if set does not replace an existing value or does not reset its TTL.
      it("set replaces the value and its TTL", async () => {
        await a.set(k("v"), "old", 1);
        await b.set(k("v"), "new", LONG_TTL);
        await clock.advance(PAST_ONE_SECOND);
        expect(await a.get(k("v"))).toBe("new");
      });

      // Fails if the store keeps a reference to the caller's object instead of a copy.
      it("callers cannot mutate stored state through written or read values", async () => {
        const input = { list: [1] };
        await a.set(k("v"), input, LONG_TTL);
        input.list.push(2);
        const read = await a.get<{ list: number[] }>(k("v"));
        read?.list.push(3);
        expect(await b.get(k("v"))).toEqual({ list: [1] });
      });

      // Fails if a non-positive TTL is accepted (it would store a value that is already expired or never expires).
      it("rejects a TTL that is not positive", async () => {
        await expect(a.set(k("v"), 1, 0)).rejects.toThrow(RangeError);
        await expect(a.putIfAbsent(k("v"), 1, -1)).rejects.toThrow(RangeError);
      });
    });

    describe("putIfAbsent", () => {
      // Fails if putIfAbsent overwrites a live value.
      it("keeps the live value and reports created false", async () => {
        expect(await a.putIfAbsent(k("p"), "first", LONG_TTL)).toEqual({ created: true, value: "first" });
        expect(await b.putIfAbsent(k("p"), "second", LONG_TTL)).toEqual({ created: false, value: "first" });
        expect(await a.get(k("p"))).toBe("first");
      });

      // Fails if putIfAbsent treats an expired value as live.
      it("writes over an expired value", async () => {
        await a.putIfAbsent(k("p"), "first", 1);
        await clock.advance(PAST_ONE_SECOND);
        expect(await b.putIfAbsent(k("p"), "second", LONG_TTL)).toEqual({ created: true, value: "second" });
      });

      // Fails if the check and the write are not one atomic step (more than one caller would see created true).
      it("creates exactly once under 20 concurrent calls from two clients", async () => {
        const results = await Promise.all(
          Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b).putIfAbsent(k("p"), `v${i}`, LONG_TTL)),
        );
        expect(results.filter((r) => r.created)).toHaveLength(1);
        const winner = results.find((r) => r.created)?.value;
        expect(new Set(results.map((r) => r.value))).toEqual(new Set([winner]));
        expect(await a.get(k("p"))).toBe(winner);
      });
    });

    describe("compareAndSet", () => {
      const v1: Doc = { version: 1, body: "one" };
      const v2: Doc = { version: 2, body: "two" };
      const v3: Doc = { version: 3, body: "three" };

      // Fails if compareAndSet does not write the next value on a version match.
      it("replaces the value when the stored version matches", async () => {
        await a.set(k("c"), v1, LONG_TTL);
        expect(await b.compareAndSet(k("c"), v1, v2, LONG_TTL)).toBe(true);
        expect(await a.get(k("c"))).toEqual(v2);
      });

      // Fails if compareAndSet ignores the stored version (a stale writer would overwrite newer state).
      it("fails for a stale expected version and keeps the newer value", async () => {
        await a.set(k("c"), v1, LONG_TTL);
        expect(await a.compareAndSet(k("c"), v1, v2, LONG_TTL)).toBe(true);
        expect(await b.compareAndSet(k("c"), v1, { version: 2, body: "stale" }, LONG_TTL)).toBe(false);
        expect(await a.get(k("c"))).toEqual(v2);
      });

      // Fails if compareAndSet accepts a next version other than expected + 1.
      it("rejects a next version that is not expected.version + 1 and leaves the value", async () => {
        await a.set(k("c"), v1, LONG_TTL);
        await expect(a.compareAndSet(k("c"), v1, v3, LONG_TTL)).rejects.toThrow(RangeError);
        await expect(a.compareAndSet(k("c"), v1, v1, LONG_TTL)).rejects.toThrow(RangeError);
        expect(await b.get(k("c"))).toEqual(v1);
      });

      // Fails if compareAndSet creates a value for a missing key.
      it("returns false for a missing key and writes nothing", async () => {
        expect(await a.compareAndSet(k("c"), v1, v2, LONG_TTL)).toBe(false);
        expect(await b.get(k("c"))).toBeNull();
      });

      // Fails if compareAndSet matches an expired value.
      it("returns false for an expired value", async () => {
        await a.set(k("c"), v1, 1);
        await clock.advance(PAST_ONE_SECOND);
        expect(await b.compareAndSet(k("c"), v1, v2, LONG_TTL)).toBe(false);
        expect(await a.get(k("c"))).toBeNull();
      });

      // Fails if the version check and the write are not atomic (more than one concurrent writer would succeed).
      it("lets exactly one of 10 concurrent writers succeed", async () => {
        await a.set(k("c"), v1, LONG_TTL);
        const results = await Promise.all(
          Array.from({ length: 10 }, (_, i) =>
            (i % 2 ? a : b).compareAndSet(k("c"), v1, { version: 2, body: `w${i}` }, LONG_TTL),
          ),
        );
        expect(results.filter(Boolean)).toHaveLength(1);
      });
    });

    describe("incrementWindow", () => {
      // Fails if the counter is not shared or `by` is ignored.
      it("counts increments from both clients and honors by", async () => {
        expect(await a.incrementWindow(k("w"), 3600)).toBe(1);
        expect(await b.incrementWindow(k("w"), 3600)).toBe(2);
        expect(await a.incrementWindow(k("w"), 3600, 5)).toBe(7);
      });

      // Fails if increments are not atomic (lost updates under concurrency).
      it("loses no increment under 20 concurrent calls", async () => {
        const counts = await Promise.all(
          Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b).incrementWindow(k("w"), 3600)),
        );
        expect([...counts].sort((x, y) => x - y)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
      });

      // Fails if the counter never resets when its window ends.
      it("starts a new count after the window ends", async () => {
        await a.incrementWindow(k("w"), 1);
        await a.incrementWindow(k("w"), 1);
        await clock.advance(PAST_ONE_SECOND);
        expect(await b.incrementWindow(k("w"), 1)).toBe(1);
      });
    });

    describe("leases", () => {
      // Fails if a second client can acquire a live lease.
      it("is exclusive across clients", async () => {
        const token = await a.acquireLease(k("l"), LONG_TTL);
        expect(token).toEqual(expect.any(String));
        expect(await b.acquireLease(k("l"), LONG_TTL)).toBeNull();
        expect(await a.acquireLease(k("l"), LONG_TTL)).toBeNull();
      });

      // Fails if acquisition is not atomic (two concurrent acquirers would both get a token).
      it("gives exactly one token to 10 concurrent acquirers", async () => {
        const tokens = await Promise.all(
          Array.from({ length: 10 }, (_, i) => (i % 2 ? a : b).acquireLease(k("l"), LONG_TTL)),
        );
        expect(tokens.filter((t) => t !== null)).toHaveLength(1);
      });

      // Fails if renewLease does not extend the expiry.
      it("renewal keeps the lease past its first TTL", async () => {
        const token = await a.acquireLease(k("l"), 2);
        await clock.advance(1000);
        expect(await a.renewLease(k("l"), token as string, 2)).toBe(true);
        await clock.advance(1500);
        expect(await b.acquireLease(k("l"), LONG_TTL)).toBeNull();
      });

      // Fails if an expired lease still blocks acquisition.
      it("can be reacquired after it expires", async () => {
        const first = await a.acquireLease(k("l"), 1);
        await clock.advance(PAST_ONE_SECOND);
        const second = await b.acquireLease(k("l"), LONG_TTL);
        expect(second).toEqual(expect.any(String));
        expect(second).not.toBe(first);
      });

      // Fails if renewLease ignores expiry or the token.
      it("cannot be renewed after expiry or with a wrong token", async () => {
        const token = await a.acquireLease(k("l"), 1);
        expect(await b.renewLease(k("l"), "not-the-token", LONG_TTL)).toBe(false);
        await clock.advance(PAST_ONE_SECOND);
        expect(await a.renewLease(k("l"), token as string, LONG_TTL)).toBe(false);
        expect(await b.acquireLease(k("l"), LONG_TTL)).toEqual(expect.any(String));
      });

      // Fails if releaseLease does not free the lease for its owner.
      it("release by the owner frees it", async () => {
        const token = await a.acquireLease(k("l"), LONG_TTL);
        expect(await a.releaseLease(k("l"), token as string)).toBe(true);
        expect(await b.acquireLease(k("l"), LONG_TTL)).toEqual(expect.any(String));
      });

      // Fails if releaseLease or renewLease checks only the key and not the owning token.
      it("a late release or renewal by the old owner does not touch the successor's lease", async () => {
        const old = await a.acquireLease(k("l"), 1);
        await clock.advance(PAST_ONE_SECOND);
        const successor = await b.acquireLease(k("l"), LONG_TTL);
        expect(successor).toEqual(expect.any(String));
        expect(await a.releaseLease(k("l"), old as string)).toBe(false);
        expect(await a.renewLease(k("l"), old as string, LONG_TTL)).toBe(false);
        expect(await a.acquireLease(k("l"), LONG_TTL)).toBeNull();
        expect(await b.renewLease(k("l"), successor as string, LONG_TTL)).toBe(true);
      });
    });

    describe("queues", () => {
      // Fails if claimNext is not FIFO across clients.
      it("claims items in enqueue order", async () => {
        await a.enqueue(k("q"), "x", LONG_TTL);
        await b.enqueue(k("q"), "y", LONG_TTL);
        await a.enqueue(k("q"), "z", LONG_TTL);
        expect(await b.claimNext(k("q"))).toBe("x");
        expect(await a.claimNext(k("q"))).toBe("y");
        expect(await b.claimNext(k("q"))).toBe("z");
        expect(await a.claimNext(k("q"))).toBeNull();
      });

      // Fails if enqueue adds a duplicate entry for a live item or moves it to the back.
      it("enqueue is idempotent for a live item", async () => {
        await a.enqueue(k("q"), "x", LONG_TTL);
        await b.enqueue(k("q"), "y", LONG_TTL);
        await b.enqueue(k("q"), "x", LONG_TTL);
        expect(await a.claimNext(k("q"))).toBe("x");
        expect(await a.claimNext(k("q"))).toBe("y");
        expect(await a.claimNext(k("q"))).toBeNull();
      });

      // Fails if claimNext is not atomic (two concurrent claims would return the same item).
      it("concurrent claims never return the same item twice", async () => {
        for (let i = 0; i < 10; i++) await a.enqueue(k("q"), `item-${i}`, LONG_TTL);
        const claims = await Promise.all(Array.from({ length: 16 }, (_, i) => (i % 2 ? a : b).claimNext(k("q"))));
        const items = claims.filter((c): c is string => c !== null);
        expect(items).toHaveLength(10);
        expect(new Set(items).size).toBe(10);
      });

      // Fails if claimNext returns an expired item, or if an expired entry keeps its old place.
      it("skips and removes expired items", async () => {
        await a.enqueue(k("q"), "x", 1);
        await a.enqueue(k("q"), "y", LONG_TTL);
        await clock.advance(PAST_ONE_SECOND);
        await b.enqueue(k("q"), "z", LONG_TTL);
        await b.enqueue(k("q"), "x", LONG_TTL);
        expect(await a.claimNext(k("q"))).toBe("y");
        expect(await a.claimNext(k("q"))).toBe("z");
        expect(await b.claimNext(k("q"))).toBe("x");
        expect(await b.claimNext(k("q"))).toBeNull();
      });

      // Fails if queues share state across names.
      it("keeps queues separate", async () => {
        await a.enqueue(k("q1"), "x", LONG_TTL);
        expect(await b.claimNext(k("q2"))).toBeNull();
        expect(await b.claimNext(k("q1"))).toBe("x");
      });
    });

    describe("claimWithLease", () => {
      const keys = () => [k("l0"), k("l1"), k("l2")];

      // Fails if an empty queue still takes (or briefly takes) a lease: dispatch with nothing queued must cost no lease work.
      it("returns null and takes no lease when the queue is empty", async () => {
        expect(await a.claimWithLease(k("q"), keys(), LONG_TTL)).toBeNull();
        for (const key of keys()) expect(await b.acquireLease(key, LONG_TTL)).toEqual(expect.any(String));
      });

      // Fails if a claim with every lease held removes the item (it would be lost) or returns it.
      it("returns null and keeps the item queued when every lease is held", async () => {
        for (const key of keys()) await a.acquireLease(key, LONG_TTL);
        await a.enqueue(k("q"), "x", LONG_TTL);
        expect(await b.claimWithLease(k("q"), keys(), LONG_TTL)).toBeNull();
        expect(await b.claimNext(k("q"))).toBe("x");
      });

      // Fails if the lease is not the first free one in order, the item is not the oldest, or the lease is not real.
      it("takes the first free lease and the oldest item in one call", async () => {
        await a.acquireLease(k("l0"), LONG_TTL);
        await a.enqueue(k("q"), "x", LONG_TTL);
        await a.enqueue(k("q"), "y", LONG_TTL);
        const claim = await b.claimWithLease(k("q"), keys(), LONG_TTL);
        expect(claim).toEqual({ itemId: "x", leaseKey: k("l1"), token: expect.any(String) });
        expect(await a.acquireLease(k("l1"), LONG_TTL)).toBeNull();
        expect(await a.renewLease(k("l1"), claim!.token, LONG_TTL)).toBe(true);
        expect(await a.releaseLease(k("l1"), claim!.token)).toBe(true);
        expect(await a.claimNext(k("q"))).toBe("y");
      });

      // Fails if an expired lease blocks the claim, or an expired item is returned.
      it("reuses an expired lease and skips expired items", async () => {
        await a.acquireLease(k("l0"), 1);
        await a.enqueue(k("q"), "old", 1);
        await a.enqueue(k("q"), "live", LONG_TTL);
        await clock.advance(PAST_ONE_SECOND);
        expect(await b.claimWithLease(k("q"), [k("l0")], LONG_TTL)).toEqual({ itemId: "live", leaseKey: k("l0"), token: expect.any(String) });
      });

      // Fails if the claim is not atomic: concurrent claims would share a lease or an item, or lose items.
      it("concurrent claims never share a lease or an item", async () => {
        for (let i = 0; i < 5; i++) await a.enqueue(k("q"), `item-${i}`, LONG_TTL);
        const claims = await Promise.all(Array.from({ length: 10 }, (_, i) => (i % 2 ? a : b).claimWithLease(k("q"), [k("l0"), k("l1")], LONG_TTL)));
        const won = claims.filter((c) => c !== null);
        expect(won).toHaveLength(2);
        expect(new Set(won.map((c) => c.leaseKey))).toEqual(new Set([k("l0"), k("l1")]));
        expect(new Set(won.map((c) => c.itemId)).size).toBe(2);
        const rest: string[] = [];
        for (let next = await a.claimNext(k("q")); next !== null; next = await a.claimNext(k("q"))) rest.push(next);
        expect(rest).toHaveLength(3);
        expect(new Set([...rest, ...won.map((c) => c.itemId)]).size).toBe(5);
      });

      // Fails if a TTL that is not positive is accepted.
      it("rejects a TTL that is not positive", async () => {
        await expect(a.claimWithLease(k("q"), keys(), 0)).rejects.toThrow(RangeError);
      });
    });

    // countOnce (src/lib/fetch/limits.ts) composes putIfAbsent, incrementWindow,
    // compareAndSet and delete; these cases prove the composition on each adapter.
    describe("countOnce composition", () => {
      // Fails if a concurrent duplicate passes on the first caller's marker before that caller knows
      // whether the counter admitted it (validation V04: an exhausted cap returned [false, true]).
      it("a concurrent duplicate cannot pass a full window", async () => {
        await a.incrementWindow(k("c"), LONG_TTL);
        const results = await Promise.all([countOnce(a, k("m"), k("c"), LONG_TTL, 1), countOnce(b, k("m"), k("c"), LONG_TTL, 1)]);
        expect(results).toEqual(["refused", "refused"]);
        // A later repeat is refused too; it never passes on a marker left behind.
        expect(await countOnce(b, k("m"), k("c"), LONG_TTL, 1)).toBe("refused");
      });

      // Fails if parallel duplicates of an admitted marker count more than once or are refused.
      it("parallel duplicates with room are all admitted and count once", async () => {
        const results = await Promise.all(Array.from({ length: 6 }, (_, i) => countOnce(i % 2 ? a : b, k("m"), k("c"), LONG_TTL, 5)));
        expect(results).toEqual(Array(6).fill("admitted"));
        expect(await a.incrementWindow(k("c"), LONG_TTL, 0)).toBe(1);
      });

      // Fails if distinct markers racing for the last place are both admitted.
      it("two distinct markers racing for the last place admit exactly one", async () => {
        await a.incrementWindow(k("c"), LONG_TTL, 4);
        const results = await Promise.all([countOnce(a, k("m1"), k("c"), LONG_TTL, 5), countOnce(b, k("m2"), k("c"), LONG_TTL, 5)]);
        expect([...results].sort()).toEqual(["admitted", "refused"]);
        // The admitted marker keeps passing; the refused one keeps failing.
        const winner = results[0] === "admitted" ? k("m1") : k("m2");
        const loser = results[0] === "admitted" ? k("m2") : k("m1");
        expect(await countOnce(b, winner, k("c"), LONG_TTL, 5)).toBe("admitted");
        expect(await countOnce(a, loser, k("c"), LONG_TTL, 5)).toBe("refused");
      });
    });
  });
}
