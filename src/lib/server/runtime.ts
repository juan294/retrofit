import { createHmac } from "node:crypto";
import { after } from "next/server";
import type { AccountData } from "@/lib/accounts/data";
import { createMemoryAccountData } from "@/lib/accounts/memory";
import { createSupabaseAccountData } from "@/lib/accounts/supabase";
import { getConfig, type Config } from "@/lib/config";
import { createFetchContext } from "@/lib/fetch/context";
import type { FetchContext } from "@/lib/fetch/http";
import { scoreSnapshot } from "@/lib/score/score";
import type { Snapshot } from "@/lib/snapshot/types";
import { createMemoryStore } from "@/lib/store/memory";
import { createSupabaseStore } from "@/lib/store/supabase";
import { fixtureClock } from "@/lib/test-fixtures/clock";
import { systemClock, type Clock, type Store } from "@/lib/store/types";

/**
 * Everything a route handler needs, bundled so tests inject their own store,
 * clock, fetch context, background-task collector and score function.
 */
export interface ServerDeps {
  readonly config: Config;
  readonly store: Store;
  /** Relational account data (notify signups; accounts, claims, publishing and billing in later phases). */
  readonly accounts: AccountData;
  readonly clock: Clock;
  readonly fetch: FetchContext;
  /** Keeps background work (crawl workers) alive after the response. `after()` in production. */
  readonly waitUntil: (task: Promise<unknown>) => void;
  /** Computes the score stored on a ready crawl job. */
  readonly score: (snapshot: Snapshot) => unknown;
  /** Waits between job reads in GET /api/score. Defaults to a timer; tests may advance a fake clock instead. */
  readonly sleep?: (ms: number) => Promise<void>;
  /**
   * Starts a fresh invocation that dispatches queued jobs (POST /api/internal/dispatch).
   * A finishing worker calls it when its own invocation has no time left for a crawl.
   */
  readonly kick?: () => Promise<void>;
}

/** Bearer token for POST /api/internal/dispatch, derived from SESSION_SECRET. */
export function dispatchToken(config: Pick<Config, "sessionSecret">): string {
  return createHmac("sha256", config.sessionSecret).update("retrofit-dispatch-v1").digest("hex");
}

/** Fire-and-forget call that starts a new invocation to dispatch queued jobs. */
export function selfKick(config: Config): () => Promise<void> {
  return async () => {
    try {
      await fetch(`${config.publicOrigin}/api/internal/dispatch`, {
        method: "POST",
        headers: { authorization: `Bearer ${dispatchToken(config)}` },
        signal: AbortSignal.timeout(5000),
      });
    } catch (e) {
      console.error("Dispatch kick failed:", e instanceof Error ? e.message : String(e));
    }
  };
}

interface Singletons {
  store?: Store;
  accounts?: AccountData;
  fetch?: FetchContext;
  deps?: ServerDeps;
}

// One set per process, kept on globalThis so development reloads share it.
const g = globalThis as typeof globalThis & { __retrofitRuntime?: Singletons };
const singletons: Singletons = (g.__retrofitRuntime ??= {});

/**
 * The process-wide Store: Supabase when SUPABASE_URL and
 * SUPABASE_SERVICE_ROLE_KEY are set, memory for tests and local development
 * without them. On Vercel without them it throws, so production never falls
 * back to a per-instance memory store (loadConfig already refuses that
 * configuration on Vercel).
 */
export function getStore(config: Config = getConfig()): Store {
  if (singletons.store) return singletons.store;
  if (config.supabase) {
    singletons.store = createSupabaseStore(config.supabase);
  } else if (config.onVercel) {
    throw new Error("Supabase store not configured");
  } else {
    singletons.store = createMemoryStore();
  }
  return singletons.store;
}

/**
 * The process-wide AccountData, chosen like the Store: Supabase when it is
 * configured, memory off Vercel without it, and a refusal on Vercel without it.
 */
export function getAccountData(config: Config = getConfig()): AccountData {
  if (singletons.accounts) return singletons.accounts;
  if (config.supabase) {
    singletons.accounts = createSupabaseAccountData(config.supabase);
  } else if (config.onVercel) {
    throw new Error("Supabase account data not configured");
  } else {
    singletons.accounts = createMemoryAccountData();
  }
  return singletons.accounts;
}

export function getFetchContext(config: Config = getConfig()): FetchContext {
  singletons.fetch ??= createFetchContext({ config, store: getStore(config) });
  return singletons.fetch;
}

/** Background work through Next.js `after()`; a failure is logged with no request data. */
export function runtimeWaitUntil(task: Promise<unknown>): void {
  after(
    task.catch((e: unknown) => {
      console.error("Background task failed:", e instanceof Error ? e.message : String(e));
    }),
  );
}

export function getServerDeps(): ServerDeps {
  if (!singletons.deps) {
    const config = getConfig();
    singletons.deps = {
      config,
      store: getStore(config),
      accounts: getAccountData(config),
      // Fixtures mode only: e2e tests may offset the server clock (src/lib/test-fixtures/clock.ts).
      clock: config.fixturesEnabled ? fixtureClock : systemClock,
      fetch: getFetchContext(config),
      waitUntil: runtimeWaitUntil,
      score: scoreSnapshot,
      kick: selfKick(config),
    };
  }
  return singletons.deps;
}

export { getConfig };
