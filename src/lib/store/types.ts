/**
 * Store contract shared by the memory adapter (tests, local development) and the
 * Supabase adapter (production, Phase 7). Every operation is async and atomic.
 * Values are JSON-serializable. A TTL is in seconds and must be positive.
 */

/** A stored value that carries a version, for compareAndSet. */
export interface Versioned {
  readonly version: number;
}

/** A queue item claimed together with the lease it runs under (Store.claimWithLease). */
export interface LeasedClaim {
  readonly itemId: string;
  readonly leaseKey: string;
  readonly token: string;
}

export interface Store {
  get<T = unknown>(key: string): Promise<T | null>;
  set<T = unknown>(key: string, value: T, ttlSeconds: number): Promise<void>;
  delete(key: string): Promise<void>;

  /** Atomic: writes only when no live value exists. Returns the value now stored. */
  putIfAbsent<T = unknown>(key: string, value: T, ttlSeconds: number): Promise<{ created: boolean; value: T }>;

  /**
   * Atomic: replaces the value only when the stored value's `version` equals
   * `expected.version`. `next.version` must be `expected.version + 1`.
   * Returns false on a conflict or when no live value exists.
   */
  compareAndSet<T extends Versioned>(key: string, expected: T, next: T, ttlSeconds: number): Promise<boolean>;

  /** Atomic: adds `by` to the counter for the current fixed window and returns the new count. */
  incrementWindow(key: string, windowSeconds: number, by?: number): Promise<number>;

  /** Atomic: returns a new token when no live lease exists, else null. */
  acquireLease(key: string, ttlSeconds: number): Promise<string | null>;
  /** Extends the lease only while `token` still owns it. */
  renewLease(key: string, token: string, ttlSeconds: number): Promise<boolean>;
  /** Releases the lease only while `token` still owns it. */
  releaseLease(key: string, token: string): Promise<boolean>;

  /** Adds `itemId` to the end of `queue` (no effect when it is already queued and live). */
  enqueue(queue: string, itemId: string, ttlSeconds: number): Promise<void>;
  /** Atomic: removes and returns the oldest live item. Expired items are skipped and removed. */
  claimNext(queue: string): Promise<string | null>;

  /**
   * Atomic, one round trip: when `queue` has a live item and one of
   * `leaseKeys` has no live lease, takes the first free lease (in the given
   * order) for `ttlSeconds`, removes the oldest live item and returns both.
   * Otherwise returns null and changes nothing (expired items are still
   * removed): an empty queue takes no lease, and a full set of leases keeps
   * the item queued.
   */
  claimWithLease(queue: string, leaseKeys: readonly string[], ttlSeconds: number): Promise<LeasedClaim | null>;

  /**
   * Deletes every expired entry and returns how many were deleted (the daily cleanup cron).
   * Only the Supabase adapter has it; the memory store drops expired entries on read.
   */
  cleanup?(): Promise<number>;
}

/** The TTL and window rule of the contract above: a positive, finite number of seconds. */
export function requirePositive(seconds: number, name: string): void {
  if (!Number.isFinite(seconds) || seconds <= 0) throw new RangeError(`${name} must be a positive number of seconds`);
}

/** The compareAndSet rule of the contract above: `next.version` must be `expected.version + 1`. */
export function requireNextVersion(expected: Versioned, next: Versioned): void {
  if (next.version !== expected.version + 1) throw new RangeError("next.version must be expected.version + 1");
}

/** Clock in milliseconds since the epoch. Injectable for tests. */
export type Clock = () => number;

export const systemClock: Clock = () => Date.now();
