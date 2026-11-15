/**
 * Store contract shared by the memory adapter (tests, local development) and the
 * Supabase adapter (production, Phase 7). Every operation is async and atomic.
 * Values are JSON-serializable. A TTL is in seconds and must be positive.
 */

/** A stored value that carries a version, for compareAndSet. */
export interface Versioned {
  readonly version: number;
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
}

/** Clock in milliseconds since the epoch. Injectable for tests. */
export type Clock = () => number;

export const systemClock: Clock = () => Date.now();
