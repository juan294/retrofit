import { after } from "next/server";
import { getConfig, type Config } from "@/lib/config";
import { createFetchContext } from "@/lib/fetch/context";
import type { FetchContext } from "@/lib/fetch/http";
import { scoreSnapshot } from "@/lib/score/score";
import type { Snapshot } from "@/lib/snapshot/types";
import { createMemoryStore } from "@/lib/store/memory";
import { systemClock, type Clock, type Store } from "@/lib/store/types";

/**
 * Everything a route handler needs, bundled so tests inject their own store,
 * clock, fetch context, background-task collector and score function.
 */
export interface ServerDeps {
  readonly config: Config;
  readonly store: Store;
  readonly clock: Clock;
  readonly fetch: FetchContext;
  /** Keeps background work (crawl workers) alive after the response. `after()` in production. */
  readonly waitUntil: (task: Promise<unknown>) => void;
  /** Computes the score stored on a ready crawl job. */
  readonly score: (snapshot: Snapshot) => unknown;
  /** Waits between job reads in GET /api/score. Defaults to a timer; tests may advance a fake clock instead. */
  readonly sleep?: (ms: number) => Promise<void>;
}

interface Singletons {
  store?: Store;
  fetch?: FetchContext;
  deps?: ServerDeps;
}

// One set per process, kept on globalThis so development reloads share it.
const g = globalThis as typeof globalThis & { __retrofitRuntime?: Singletons };
const singletons: Singletons = (g.__retrofitRuntime ??= {});

/**
 * The process-wide Store. Memory for tests and local development. On Vercel it
 * throws until Phase 7 adds the Supabase adapter, so production never falls
 * back to a per-instance memory store.
 */
export function getStore(config: Config = getConfig()): Store {
  if (config.onVercel) throw new Error("Supabase store not configured");
  singletons.store ??= createMemoryStore();
  return singletons.store;
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
      clock: systemClock,
      fetch: getFetchContext(config),
      waitUntil: runtimeWaitUntil,
      score: scoreSnapshot,
    };
  }
  return singletons.deps;
}

export { getConfig };
