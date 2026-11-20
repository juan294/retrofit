import { vi } from "vitest";
import { loadConfig, type Env } from "@/lib/config";
import { slotKey } from "@/lib/analysis/capacity";
import { createFetchContext } from "@/lib/fetch/context";
import type { Resolver } from "@/lib/fetch/guard";
import type { ServerDeps } from "@/lib/server/runtime";
import { scoreSnapshot } from "@/lib/score/score";
import { createMemoryBacking, createMemoryStore, type MemoryBacking } from "@/lib/store/memory";
import type { Clock, Store } from "@/lib/store/types";
import { startFixtureServer, type FixtureHandler, type FixtureRoutes, type FixtureServer } from "./fixture-server";
import { materialize, type FixtureSite } from "../fixtures/sites";

export const PUBLIC_ORIGIN = "https://retrofit.test";

/**
 * Pacing start tolerance for test contexts with a 1 ms interval, so a real-time crawl is not slowed by
 * the production 250 ms. A start later than this takes a new slot, which only adds a short wait.
 */
export const FAST_TOLERANCE_MS = 20;

/** Every non-fixture name "resolves" to a private address, so a test can never reach the network. */
export const privateResolver: Resolver = async () => [{ address: "10.0.0.5", family: 4 }];

/** No test may contact a non-loopback host: unknown names fail instead of reaching the system resolver. */
export const noRealDns: Resolver = async (hostname) => {
  throw Object.assign(new Error(`test resolver: ${hostname} is not stubbed`), { code: "ENOTFOUND" });
};

export interface FakeClock {
  readonly clock: Clock;
  now(): number;
  set(ms: number): void;
  advance(ms: number): void;
}

/** Moves a fake clock's time, keyed by its `clock` function, so testDeps can pace on it. */
const advancers = new WeakMap<Clock, (ms: number) => void>();

/** A clock that only moves when the test moves it, or when pacing in testDeps sleeps on it. */
export function fakeClock(start = Date.parse("2026-11-15T10:20:00.000Z")): FakeClock {
  let now = start;
  const clock: Clock = () => now;
  const advance = (ms: number) => void (now += ms);
  advancers.set(clock, advance);
  return {
    clock,
    now: () => now,
    set: (ms) => void (now = ms),
    advance,
  };
}

/** A sleep that moves `clock` when it is a fakeClock (time passes during the wait); otherwise a timer. */
function sleepFor(clock: Clock): ((ms: number) => Promise<void>) | undefined {
  const advance = advancers.get(clock);
  return advance ? async (ms) => advance(ms) : undefined;
}

export interface TestDepsOptions {
  env?: Env;
  clock?: Clock;
  lookup?: Resolver;
  score?: ServerDeps["score"];
  sleep?: ServerDeps["sleep"];
  instrument?: (op: string, key: string) => void;
  backing?: MemoryBacking;
  store?: Store;
}

export interface TestDeps extends ServerDeps {
  readonly backing: MemoryBacking;
  /** Errors thrown by background tasks. Tests assert it stays empty. */
  readonly errors: unknown[];
  /** Awaits every background task, including tasks that background tasks add. */
  settle(): Promise<void>;
}

export function testDeps(o: TestDepsOptions = {}): TestDeps {
  const config = loadConfig({ SESSION_SECRET: "s".repeat(32), RETROFIT_TEST_FIXTURES: "1", PUBLIC_ORIGIN, ...o.env });
  const clock = o.clock ?? Date.now;
  const backing = o.backing ?? createMemoryBacking();
  const store = o.store ?? createMemoryStore({ clock, backing, instrument: o.instrument });
  const fetch = createFetchContext({ config, store, clock, sleep: sleepFor(clock), lookup: o.lookup ?? privateResolver, minIntervalMs: 1, lateStartToleranceMs: FAST_TOLERANCE_MS });
  const pending: Promise<unknown>[] = [];
  const errors: unknown[] = [];
  return {
    config,
    store,
    clock,
    fetch,
    score: o.score ?? scoreSnapshot,
    sleep: o.sleep,
    waitUntil: (task) => {
      pending.push(Promise.resolve(task).catch((e: unknown) => void errors.push(e)));
    },
    backing,
    errors,
    async settle() {
      while (pending.length > 0) await Promise.all(pending.splice(0));
    },
  };
}

/** Holds every crawl slot, so nothing is dispatched. */
export async function holdAllSlots(d: ServerDeps, ttlSeconds = 100_000): Promise<string[]> {
  const tokens: string[] = [];
  for (let n = 0; n < d.config.crawlMaxConcurrent; n++) {
    const t = await d.store.acquireLease(slotKey(n), ttlSeconds);
    if (!t) throw new Error(`slot ${n} already held`);
    tokens.push(t);
  }
  return tokens;
}

export interface Gate {
  open(): void;
  readonly waiting: number;
}

export interface GatedSites extends FixtureServer {
  origin(host: string): string;
  gate(host: string): Gate;
  /** Most home pages held at one time. */
  readonly maxWaiting: number;
}

/**
 * Serves fixture sites; the home page of each gated host is held until its
 * gate opens, so a test controls when crawls finish.
 */
export async function serveGatedSites(sites: Record<string, FixtureSite>, gated: string[]): Promise<GatedSites> {
  const routes: FixtureRoutes = {};
  const server = await startFixtureServer(routes);
  const origin = (host: string) => server.url(host, "").replace(/\/$/, "");
  const gates = new Map<string, { opened: boolean; waiters: (() => void)[] }>();
  let waiting = 0;
  let maxWaiting = 0;
  for (const [host, site] of Object.entries(sites)) {
    routes[host] = {};
    for (const [path, r] of Object.entries(materialize(site, origin(host)))) {
      const response = { status: r.status, headers: r.headers, body: r.body };
      if (path === "/" && gated.includes(host)) {
        const g = { opened: false, waiters: [] as (() => void)[] };
        gates.set(host, g);
        const handler: FixtureHandler = async (_req, res) => {
          if (!g.opened) {
            waiting++;
            maxWaiting = Math.max(maxWaiting, waiting);
            await new Promise<void>((resolve) => g.waiters.push(resolve));
            waiting--;
          }
          res.writeHead(response.status ?? 200, response.headers ?? {}).end(response.body ?? "");
        };
        routes[host][path] = handler;
      } else {
        routes[host][path] = response;
      }
    }
  }
  const result = Object.assign(server, {
    origin,
    gate(host: string): Gate {
      const g = gates.get(host);
      if (!g) throw new Error(`no gate for ${host}`);
      return {
        open() {
          g.opened = true;
          for (const w of g.waiters.splice(0)) w();
        },
        get waiting() {
          return g.waiters.length;
        },
      };
    },
  });
  // A getter, not a copied value (Object.assign would read it once).
  return Object.defineProperty(result, "maxWaiting", { get: () => maxWaiting }) as GatedSites;
}

/** Polls `check` on real time until it is true or 5 s pass. */
export async function waitFor(check: () => boolean | Promise<boolean>, what = "condition", timeoutMs = 5000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

// --- Requests ---

export interface RequestOptions {
  cookie?: string;
  ip?: string;
  origin?: string | null;
  fetchSite?: string | null;
  /** Sets `Authorization` when given. */
  auth?: string;
  signal?: AbortSignal;
}

/** A same-origin JSON POST from a visitor (defaults: `sec-fetch-site: same-origin`, IP 203.0.113.7). `undefined` sends no body; a string is sent as is. */
export function postRequest(path: string, body: unknown, o: RequestOptions = {}): Request {
  const headers = new Headers({ "content-type": "application/json", "x-forwarded-for": o.ip ?? "203.0.113.7" });
  if (o.fetchSite !== null) headers.set("sec-fetch-site", o.fetchSite ?? "same-origin");
  if (o.origin) headers.set("origin", o.origin);
  if (o.cookie) headers.set("cookie", o.cookie);
  if (o.auth !== undefined) headers.set("authorization", o.auth);
  return new Request(`${PUBLIC_ORIGIN}${path}`, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body), signal: o.signal });
}

export const analyzeRequest = (body: unknown, o: RequestOptions = {}): Request => postRequest("/api/analyze", body, o);

export function statusRequest(id: string, o: { cookie?: string; include?: string } = {}): Request {
  const headers = new Headers();
  if (o.cookie) headers.set("cookie", o.cookie);
  const q = o.include ? `?include=${o.include}` : "";
  return new Request(`${PUBLIC_ORIGIN}/api/analyze/${id}${q}`, { headers });
}

export function scoreRequest(query: string, o: { method?: string; ip?: string; cookie?: string } = {}): Request {
  const headers = new Headers({ "x-forwarded-for": o.ip ?? "198.51.100.9" });
  if (o.cookie) headers.set("cookie", o.cookie);
  return new Request(`${PUBLIC_ORIGIN}/api/score${query}`, { method: o.method ?? "GET", headers });
}

/** `name=value` from a Set-Cookie header, for the next request's Cookie header. */
export function cookieFrom(res: Response): string {
  const raw = res.headers.get("set-cookie");
  if (!raw) throw new Error("no Set-Cookie");
  return raw.split(";")[0] as string;
}

/** Sends every console line to `lines` (Errors with message and stack, objects as JSON), so a test can prove what is never logged. */
export function captureConsole(lines: string[]): void {
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void lines.push(args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : typeof a === "string" ? a : JSON.stringify(a))).join(" ")));
  }
}

/** Every stored value and key, as one string, to prove what is never stored. */
export function storeDump(backing: MemoryBacking): string {
  const parts: string[] = [];
  for (const [k, v] of backing.values) parts.push(k, JSON.stringify(v.value));
  for (const k of backing.windows.keys()) parts.push(k);
  for (const k of backing.leases.keys()) parts.push(k);
  for (const [k, items] of backing.queues) parts.push(k, JSON.stringify(items));
  return parts.join("\n");
}
