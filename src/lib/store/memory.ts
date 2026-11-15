import { randomUUID } from "node:crypto";
import { type Clock, type Store, type Versioned, systemClock } from "./types";

interface Entry<T> {
  value: T;
  expiresAt: number;
}

interface WindowEntry {
  count: number;
  endsAt: number;
}

interface LeaseEntry {
  token: string;
  expiresAt: number;
}

interface QueueEntry {
  itemId: string;
  expiresAt: number;
}

/** Shared state. Two stores over one backing model two server instances. */
export interface MemoryBacking {
  readonly values: Map<string, Entry<unknown>>;
  readonly windows: Map<string, WindowEntry>;
  readonly leases: Map<string, LeaseEntry>;
  readonly queues: Map<string, QueueEntry[]>;
}

export function createMemoryBacking(): MemoryBacking {
  return { values: new Map(), windows: new Map(), leases: new Map(), queues: new Map() };
}

export interface MemoryStoreOptions {
  clock?: Clock;
  backing?: MemoryBacking;
  /** Called once per operation, before it runs. Lets performance tests count store calls. */
  instrument?: (op: string, key: string) => void;
}

function requirePositive(seconds: number, name: string): void {
  if (!Number.isFinite(seconds) || seconds <= 0) throw new RangeError(`${name} must be a positive number of seconds`);
}

/**
 * In-memory Store. Each operation yields once (a microtask) and then runs its
 * read-modify-write synchronously, so concurrent callers interleave between
 * operations but never inside one. Values are deep-cloned on write and read.
 */
export function createMemoryStore(options: MemoryStoreOptions = {}): Store {
  const clock = options.clock ?? systemClock;
  const backing = options.backing ?? createMemoryBacking();
  const instrument = options.instrument;
  const { values, windows, leases, queues } = backing;

  async function op<R>(name: string, key: string, body: (now: number) => R): Promise<R> {
    instrument?.(name, key);
    await Promise.resolve();
    return body(clock());
  }

  /** The unexpired entry for `key`; an expired one is deleted. */
  function liveIn<E extends { readonly expiresAt: number }>(map: Map<string, E>, key: string, now: number): E | undefined {
    const entry = map.get(key);
    if (entry && entry.expiresAt <= now) {
      map.delete(key);
      return undefined;
    }
    return entry;
  }
  const live = (key: string, now: number) => liveIn(values, key, now);
  const liveLease = (key: string, now: number) => liveIn(leases, key, now);

  function write(key: string, value: unknown, ttlSeconds: number, now: number): void {
    values.set(key, { value: structuredClone(value), expiresAt: now + ttlSeconds * 1000 });
  }

  return {
    get<T>(key: string) {
      return op("get", key, (now) => {
        const entry = live(key, now);
        return entry ? (structuredClone(entry.value) as T) : null;
      });
    },

    set(key, value, ttlSeconds) {
      return op("set", key, (now) => {
        requirePositive(ttlSeconds, "ttlSeconds");
        write(key, value, ttlSeconds, now);
      });
    },

    delete(key) {
      return op("delete", key, () => {
        values.delete(key);
      });
    },

    putIfAbsent<T>(key: string, value: T, ttlSeconds: number) {
      return op("putIfAbsent", key, (now) => {
        requirePositive(ttlSeconds, "ttlSeconds");
        const existing = live(key, now);
        if (existing) return { created: false, value: structuredClone(existing.value) as T };
        write(key, value, ttlSeconds, now);
        return { created: true, value: structuredClone(value) };
      });
    },

    compareAndSet<T extends Versioned>(key: string, expected: T, next: T, ttlSeconds: number) {
      return op("compareAndSet", key, (now) => {
        requirePositive(ttlSeconds, "ttlSeconds");
        if (next.version !== expected.version + 1) {
          throw new RangeError("next.version must be expected.version + 1");
        }
        const stored = live(key, now)?.value as Partial<Versioned> | undefined;
        if (!stored || stored.version !== expected.version) return false;
        write(key, next, ttlSeconds, now);
        return true;
      });
    },

    incrementWindow(key, windowSeconds, by = 1) {
      return op("incrementWindow", key, (now) => {
        requirePositive(windowSeconds, "windowSeconds");
        const current = windows.get(key);
        if (!current || current.endsAt <= now) {
          windows.set(key, { count: by, endsAt: now + windowSeconds * 1000 });
          return by;
        }
        current.count += by;
        return current.count;
      });
    },

    acquireLease(key, ttlSeconds) {
      return op("acquireLease", key, (now) => {
        requirePositive(ttlSeconds, "ttlSeconds");
        if (liveLease(key, now)) return null;
        const token = randomUUID();
        leases.set(key, { token, expiresAt: now + ttlSeconds * 1000 });
        return token;
      });
    },

    renewLease(key, token, ttlSeconds) {
      return op("renewLease", key, (now) => {
        requirePositive(ttlSeconds, "ttlSeconds");
        const lease = liveLease(key, now);
        if (!lease || lease.token !== token) return false;
        lease.expiresAt = now + ttlSeconds * 1000;
        return true;
      });
    },

    releaseLease(key, token) {
      return op("releaseLease", key, (now) => {
        const lease = liveLease(key, now);
        if (!lease || lease.token !== token) return false;
        leases.delete(key);
        return true;
      });
    },

    enqueue(queue, itemId, ttlSeconds) {
      return op("enqueue", queue, (now) => {
        requirePositive(ttlSeconds, "ttlSeconds");
        const items = (queues.get(queue) ?? []).filter((item) => item.expiresAt > now);
        if (!items.some((item) => item.itemId === itemId)) {
          items.push({ itemId, expiresAt: now + ttlSeconds * 1000 });
        }
        queues.set(queue, items);
      });
    },

    claimNext(queue) {
      return op("claimNext", queue, (now) => {
        const items = queues.get(queue);
        if (!items) return null;
        let claimed: string | null = null;
        while (items.length > 0 && claimed === null) {
          const head = items.shift() as QueueEntry;
          if (head.expiresAt > now) claimed = head.itemId;
        }
        if (items.length === 0) queues.delete(queue);
        return claimed;
      });
    },
  };
}
