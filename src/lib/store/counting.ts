import type { Store } from "./types";

export interface CountingStore {
  readonly store: Store;
  /** Number of `get` calls on keys that match the filter. */
  reads(): number;
}

/** Wraps a store and counts reads. Used only in fixtures mode to measure the status route's store budget. */
export function countReads(store: Store, keyFilter: (key: string) => boolean = () => true): CountingStore {
  let reads = 0;
  const get: Store["get"] = (key) => {
    if (keyFilter(key)) reads++;
    return store.get(key);
  };
  const wrapped = new Proxy(store, { get: (target, prop, receiver) => (prop === "get" ? get : Reflect.get(target, prop, receiver)) });
  return { store: wrapped, reads: () => reads };
}
