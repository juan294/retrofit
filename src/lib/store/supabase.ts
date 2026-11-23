import { serviceCall, serviceClient, ServiceUnavailable, type ServiceClientOptions, type ServiceClientSource } from "@/lib/supabase/client";
import { type LeasedClaim, type Store, type Versioned, requireNextVersion, requirePositive } from "./types";

/**
 * Supabase Store (production). Server only: it holds the service role key, so
 * never import it from client code. Every operation is one PostgREST rpc call
 * to a `store_*` function in supabase/migrations/ (*_store.sql and later
 * migrations such as *_claim_with_lease.sql), so each one is a
 * single database transaction and the database clock decides expiry.
 *
 * A failed call logs `[TABLE_FALLBACK]` at ERROR with the operation and the
 * key's first segment (never the value, the full key or a secret) and throws
 * StoreUnavailable. There is no fallback: callers fail closed.
 */

/** Options for a client of its own (tests, tools); the runtime passes its shared client instead. */
export type SupabaseStoreOptions = ServiceClientOptions;

export class StoreUnavailable extends ServiceUnavailable {
  constructor(operation: string, code: string) {
    super(operation, code, `store ${operation} failed (${code})`);
    this.name = "StoreUnavailable";
  }
}

/** The key's first `:` segment, capped, for logs. Keys carry hashed or random ids after the first segment. */
export function keyPrefix(key: string): string {
  const head = key.split(":", 1)[0] ?? "";
  return head.length > 48 ? `${head.slice(0, 48)}...` : head;
}

export function createSupabaseStore(source: ServiceClientSource): Store & Required<Pick<Store, "cleanup">> {
  const client = serviceClient(source);

  function call<R>(operation: string, key: string, fn: string, args: Record<string, unknown>): Promise<R> {
    const label = { service: "store", operation, detail: `key prefix "${keyPrefix(key)}"` };
    return serviceCall<R>(label, () => client.rpc(fn, args), (code) => new StoreUnavailable(operation, code)) as Promise<R>;
  }

  return {
    async get<T>(key: string) {
      return call<T | null>("get", key, "store_get", { p_key: key });
    },

    async set(key, value, ttlSeconds) {
      requirePositive(ttlSeconds, "ttlSeconds");
      await call("set", key, "store_set", { p_key: key, p_value: value ?? null, p_ttl_seconds: ttlSeconds });
    },

    async delete(key) {
      await call("delete", key, "store_delete", { p_key: key });
    },

    async putIfAbsent<T>(key: string, value: T, ttlSeconds: number) {
      requirePositive(ttlSeconds, "ttlSeconds");
      const r = await call<{ created: boolean; value: T }>("putIfAbsent", key, "store_put_if_absent", {
        p_key: key,
        p_value: value ?? null,
        p_ttl_seconds: ttlSeconds,
      });
      return { created: r.created, value: r.value };
    },

    async compareAndSet<T extends Versioned>(key: string, expected: T, next: T, ttlSeconds: number) {
      requirePositive(ttlSeconds, "ttlSeconds");
      requireNextVersion(expected, next);
      return call<boolean>("compareAndSet", key, "store_compare_and_set", {
        p_key: key,
        p_expected_version: expected.version,
        p_next: next,
        p_ttl_seconds: ttlSeconds,
      });
    },

    async incrementWindow(key, windowSeconds, by = 1) {
      requirePositive(windowSeconds, "windowSeconds");
      const n = await call<number | string>("incrementWindow", key, "store_increment_window", {
        p_key: key,
        p_window_seconds: windowSeconds,
        p_by: by,
      });
      return Number(n);
    },

    async acquireLease(key, ttlSeconds) {
      requirePositive(ttlSeconds, "ttlSeconds");
      return call<string | null>("acquireLease", key, "store_acquire_lease", { p_key: key, p_ttl_seconds: ttlSeconds });
    },

    async renewLease(key, token, ttlSeconds) {
      requirePositive(ttlSeconds, "ttlSeconds");
      return call<boolean>("renewLease", key, "store_renew_lease", { p_key: key, p_token: token, p_ttl_seconds: ttlSeconds });
    },

    async releaseLease(key, token) {
      return call<boolean>("releaseLease", key, "store_release_lease", { p_key: key, p_token: token });
    },

    async enqueue(queue, itemId, ttlSeconds) {
      requirePositive(ttlSeconds, "ttlSeconds");
      await call("enqueue", queue, "store_enqueue", { p_queue: queue, p_item_id: itemId, p_ttl_seconds: ttlSeconds });
    },

    async claimNext(queue) {
      return call<string | null>("claimNext", queue, "store_claim_next", { p_queue: queue });
    },

    async claimWithLease(queue, leaseKeys, ttlSeconds) {
      requirePositive(ttlSeconds, "ttlSeconds");
      const r = await call<LeasedClaim | null>("claimWithLease", queue, "store_claim_with_lease", {
        p_queue: queue,
        p_lease_keys: [...leaseKeys],
        p_ttl_seconds: ttlSeconds,
      });
      return r ? { itemId: r.itemId, leaseKey: r.leaseKey, token: r.token } : null;
    },

    async cleanup() {
      const counts = await call<Record<string, number> | null>("cleanup", "*", "store_cleanup", {});
      return Object.values(counts ?? {}).reduce((sum, n) => sum + Number(n), 0);
    },
  };
}
