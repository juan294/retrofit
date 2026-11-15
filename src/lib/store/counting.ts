import type { Store } from "./types";

export interface CountingStore {
  readonly store: Store;
  /** Number of `get` calls on keys that match the filter. */
  reads(): number;
  /** Number of calls to any Store operation, whatever the key. */
  operations(): number;
  /** Calls per operation name. */
  byOperation(): Record<string, number>;
}

/**
 * Wraps a store and counts its calls: filtered reads, and every operation.
 * Used only in fixtures mode to measure the status route's store budget,
 * including the dispatch work a request starts.
 */
export function countReads(store: Store, keyFilter: (key: string) => boolean = () => true): CountingStore {
  let reads = 0;
  const calls: Record<string, number> = {};
  const wrapped = new Proxy(store, {
    get: (target, prop, receiver) => {
      const value: unknown = Reflect.get(target, prop, receiver);
      if (typeof value !== "function" || typeof prop !== "string") return value;
      return (...args: unknown[]) => {
        calls[prop] = (calls[prop] ?? 0) + 1;
        if (prop === "get" && keyFilter(args[0] as string)) reads++;
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return {
    store: wrapped,
    reads: () => reads,
    operations: () => Object.values(calls).reduce((sum, n) => sum + n, 0),
    byOperation: () => ({ ...calls }),
  };
}

/**
 * Fixtures mode only: the JSON of the status route's `x-retrofit-store-work`
 * header (tests/helpers/perf-oracle.ts reads it).
 */
export interface StoreWork {
  /** Every store operation of the request itself. */
  readonly foreground: number;
  /**
   * The background dispatch this request started, counted until it resolved:
   * workers started, store operations and claimWithLease calls. Null when the
   * request started none (a 404) or the dispatch failed.
   */
  readonly dispatch: { readonly started: number; readonly operations: number; readonly claims: number } | null;
}
