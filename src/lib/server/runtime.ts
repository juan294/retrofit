import { createHmac } from "node:crypto";
import { after } from "next/server";
import type { AccountData } from "@/lib/accounts/data";
import { createMemoryAccountData } from "@/lib/accounts/memory";
import { createSupabaseAccountData } from "@/lib/accounts/supabase";
import { unavailableAuthGateway, type AuthGateway } from "@/lib/auth/gateway";
import { createSupabaseAuthGateway } from "@/lib/auth/supabase";
import { systemTxtResolver, type TxtResolver } from "@/lib/claims/txt";
import { getConfig, type Config, type SupabaseConfig } from "@/lib/config";
import { createFetchContext } from "@/lib/fetch/context";
import type { FetchContext } from "@/lib/fetch/http";
import { scoreSnapshot } from "@/lib/score/score";
import type { Snapshot } from "@/lib/snapshot/types";
import { createMemoryStore } from "@/lib/store/memory";
import { createSupabaseStore } from "@/lib/store/supabase";
import { createServiceClient, type ServiceClient } from "@/lib/supabase/client";
import { createFixtureAuth, type FixtureAuth } from "@/lib/test-fixtures/auth";
import { fixtureClock } from "@/lib/test-fixtures/clock";
import { fixtureOutage } from "@/lib/test-fixtures/outage";
import { fixtureTxtResolver } from "@/lib/test-fixtures/txt";
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
  /** Email-link sign-in (Supabase Auth; the fixture provider in fixtures mode). */
  readonly auth: AuthGateway;
  readonly clock: Clock;
  readonly fetch: FetchContext;
  /** DNS TXT lookups for ownership claims: the system resolver, or the fixtures resolver in fixtures mode. */
  readonly txt: TxtResolver;
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
  /** One service client per Supabase project, shared by the Store and AccountData adapters. */
  supabase?: { readonly url: string; readonly serviceRoleKey: string; readonly client: ServiceClient };
  store?: Store;
  accounts?: AccountData;
  auth?: AuthGateway;
  fixtureAuth?: FixtureAuth;
  fetch?: FetchContext;
  deps?: ServerDeps;
}

// One set per process, kept on globalThis so development reloads share it.
const g = globalThis as typeof globalThis & { __retrofitRuntime?: Singletons };
const singletons: Singletons = (g.__retrofitRuntime ??= {});

function sharedServiceClient(supabase: SupabaseConfig): ServiceClient {
  const cached = singletons.supabase;
  if (cached?.url === supabase.url && cached.serviceRoleKey === supabase.serviceRoleKey) return cached.client;
  const client = createServiceClient(supabase);
  singletons.supabase = { url: supabase.url, serviceRoleKey: supabase.serviceRoleKey, client };
  return client;
}

/**
 * A process-wide data adapter: Supabase when SUPABASE_URL and
 * SUPABASE_SERVICE_ROLE_KEY are set, memory for tests and local development
 * without them. On Vercel without them it throws, so production never falls
 * back to a per-instance memory adapter (loadConfig already refuses that
 * configuration on Vercel).
 */
function dataAdapter<T>(config: Config, name: string, supabase: (client: ServiceClient) => T, memory: () => T): T {
  if (config.supabase) return supabase(sharedServiceClient(config.supabase));
  if (config.onVercel) throw new Error(`Supabase ${name} not configured`);
  return memory();
}

/** The process-wide Store (dataAdapter). */
export function getStore(config: Config = getConfig()): Store {
  singletons.store ??= dataAdapter(config, "store", createSupabaseStore, createMemoryStore);
  return singletons.store;
}

/** The process-wide AccountData (dataAdapter). */
export function getAccountData(config: Config = getConfig()): AccountData {
  singletons.accounts ??= dataAdapter(config, "account data", createSupabaseAccountData, createMemoryAccountData);
  return singletons.accounts;
}

/**
 * The process-wide AuthGateway: the fixture provider in fixtures mode (browser tests read its
 * mailbox), Supabase Auth when SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and SUPABASE_ANON_KEY are
 * set, and otherwise (local development without Supabase) a gateway that answers unavailable, so
 * sign-in shows the mail-unavailable text. loadConfig requires the anon key on Vercel.
 */
export function getAuthGateway(config: Config = getConfig()): AuthGateway {
  if (!singletons.auth) {
    const fixture = getFixtureAuth(config);
    if (fixture) singletons.auth = fixture;
    else if (config.supabase?.anonKey) {
      singletons.auth = createSupabaseAuthGateway({ url: config.supabase.url, anonKey: config.supabase.anonKey, admin: sharedServiceClient(config.supabase) });
    } else singletons.auth = unavailableAuthGateway();
  }
  return singletons.auth;
}

/** Fixtures mode only: the process-wide fixture provider (its mailbox serves /test-fixtures/mailbox). Null otherwise. */
export function getFixtureAuth(config: Config = getConfig()): FixtureAuth | null {
  if (!config.fixturesEnabled) return null;
  singletons.fixtureAuth ??= createFixtureAuth({ clock: fixtureClock, origin: config.publicOrigin });
  return singletons.fixtureAuth;
}

/** The server clock. Fixtures mode only: e2e tests may offset it (src/lib/test-fixtures/clock.ts). */
export function serverClock(config: Pick<Config, "fixturesEnabled">): Clock {
  return config.fixturesEnabled ? fixtureClock : systemClock;
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
      // Built on first use, so routes that never read account data do not create it.
      get accounts() {
        // Browser tests can turn on an outage (fixtures mode only).
        return config.fixturesEnabled ? fixtureOutage(getAccountData(config)) : getAccountData(config);
      },
      get auth() {
        return getAuthGateway(config);
      },
      clock: serverClock(config),
      fetch: getFetchContext(config),
      txt: config.fixturesEnabled ? fixtureTxtResolver : systemTxtResolver,
      waitUntil: runtimeWaitUntil,
      score: scoreSnapshot,
      kick: selfKick(config),
    };
  }
  return singletons.deps;
}

export { getConfig };
