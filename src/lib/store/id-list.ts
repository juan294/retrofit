import type { Store } from "./types";

/**
 * A small versioned list in one Store value: ids (the visitor's analyses, an
 * account's sessions) or small entries (an account's analyses). The Store has
 * no secondary index, so these lists are how Retrofit finds the records that
 * belong to one visitor or one account.
 */
export interface IdList<T = string> {
  readonly version: number;
  readonly ids: readonly T[];
}

const ATTEMPTS = 5;

/**
 * Applies `change` to the list with compare-and-set (creating it when absent),
 * so two writers never lose each other's ids. Every call also renews the
 * list's TTL to `ttlSeconds`. Returns the ids before and after the change.
 */
export async function updateIdList<T = string>(
  store: Store,
  key: string,
  change: (ids: readonly T[]) => readonly T[],
  ttlSeconds: number,
): Promise<{ before: readonly T[]; after: readonly T[] }> {
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    let current = await store.get<IdList<T>>(key);
    if (!current) {
      const first: IdList<T> = { version: 1, ids: change([]) };
      const put = await store.putIfAbsent<IdList<T>>(key, first, ttlSeconds);
      if (put.created) return { before: [], after: first.ids };
      current = put.value;
    }
    const next: IdList<T> = { version: current.version + 1, ids: change(current.ids) };
    if (await store.compareAndSet(key, current, next, ttlSeconds)) return { before: current.ids, after: next.ids };
  }
  throw new Error(`id list ${key.split(":")[0]} kept changing`);
}

/** The list's ids, or none. */
export async function readIdList<T = string>(store: Store, key: string): Promise<readonly T[]> {
  return (await store.get<IdList<T>>(key))?.ids ?? [];
}

/** Adds `id` at the end (moving it there when present) and keeps the newest `max` ids. */
export const appendBounded =
  (id: string, max: number) =>
  (ids: readonly string[]): readonly string[] =>
    [...ids.filter((x) => x !== id), id].slice(-max);
