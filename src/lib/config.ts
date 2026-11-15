import { randomBytes } from "node:crypto";

export class ConfigError extends Error {
  constructor(
    public readonly variable: string,
    message: string,
  ) {
    super(`${variable}: ${message}`);
    this.name = "ConfigError";
  }
}

export type Env = Record<string, string | undefined>;

export interface Config {
  readonly crawlMaxPages: number;
  readonly fetchTimeoutMs: number;
  readonly fetchMaxBytes: number;
  readonly crawlBudgetMs: number;
  readonly crawlLeaseTtlS: number;
  readonly crawlCacheTtlS: number;
  readonly crawlMaxConcurrent: number;
  readonly crawlMaxHostsPerDay: number;
  readonly queueMaxWaitS: number;
  readonly analysesPerClientHour: number;
  readonly staleAfterS: number;
  readonly analysisTtlS: number;
  readonly scoreWaitMs: number;
  readonly publicOrigin: string;
  readonly sessionSecret: string;
  readonly onVercel: boolean;
  readonly fixturesEnabled: boolean;
}

const NUMBERS = {
  crawlMaxPages: ["CRAWL_MAX_PAGES", 12],
  fetchTimeoutMs: ["FETCH_TIMEOUT_MS", 8000],
  fetchMaxBytes: ["FETCH_MAX_BYTES", 2097152],
  crawlBudgetMs: ["CRAWL_BUDGET_MS", 45000],
  crawlLeaseTtlS: ["CRAWL_LEASE_TTL_S", 60],
  crawlCacheTtlS: ["CRAWL_CACHE_TTL_S", 86400],
  crawlMaxConcurrent: ["CRAWL_MAX_CONCURRENT", 8],
  crawlMaxHostsPerDay: ["CRAWL_MAX_HOSTS_PER_DAY", 1000],
  queueMaxWaitS: ["QUEUE_MAX_WAIT_S", 120],
  analysesPerClientHour: ["ANALYSES_PER_CLIENT_HOUR", 20],
  staleAfterS: ["STALE_AFTER_S", 90],
  analysisTtlS: ["ANALYSIS_TTL_S", 604800],
  scoreWaitMs: ["SCORE_WAIT_MS", 25000],
} as const satisfies Record<string, readonly [string, number]>;

type NumberKey = keyof typeof NUMBERS;

export function parsePositive(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+(\.\d+)?$/.test(raw.trim())) throw new ConfigError(name, `must be a positive number, got "${raw}"`);
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new ConfigError(name, `must be a positive number, got "${raw}"`);
  return n;
}

function parseOrigin(name: string, raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new ConfigError(name, "must be an absolute http or https origin");
  }
  if ((u.protocol !== "https:" && u.protocol !== "http:") || (u.pathname !== "/" && u.pathname !== "") || u.search || u.hash || u.username) {
    throw new ConfigError(name, "must be an origin with no path, query or credentials");
  }
  return u.origin;
}

export function isOnVercel(env: Env): boolean {
  return Boolean(env.VERCEL || env.VERCEL_ENV);
}

export function loadConfig(env: Env): Config {
  const numbers = {} as Record<NumberKey, number>;
  for (const key of Object.keys(NUMBERS) as NumberKey[]) {
    const [name, fallback] = NUMBERS[key];
    numbers[key] = parsePositive(env, name, fallback);
  }
  if (numbers.crawlLeaseTtlS >= numbers.staleAfterS) {
    throw new ConfigError("CRAWL_LEASE_TTL_S", "must be less than STALE_AFTER_S");
  }
  // A crawl must fit in one 60 s function invocation with a 10 s margin (analysis/capacity.ts).
  if (numbers.crawlBudgetMs > 50_000) {
    throw new ConfigError("CRAWL_BUDGET_MS", "must be at most 50000 so a crawl fits in one function invocation");
  }
  if (numbers.crawlBudgetMs >= numbers.crawlLeaseTtlS * 1000) {
    throw new ConfigError("CRAWL_BUDGET_MS", "must be less than CRAWL_LEASE_TTL_S * 1000");
  }

  const onVercel = isOnVercel(env);
  const fixturesEnabled = Boolean(env.RETROFIT_TEST_FIXTURES);
  if (onVercel && fixturesEnabled) {
    throw new ConfigError("RETROFIT_TEST_FIXTURES", "must not be set on Vercel");
  }

  let sessionSecret = env.SESSION_SECRET ?? "";
  if (onVercel) {
    if (Buffer.byteLength(sessionSecret) < 32) throw new ConfigError("SESSION_SECRET", "is required on Vercel (32 bytes or more)");
    if (!env.PUBLIC_ORIGIN) throw new ConfigError("PUBLIC_ORIGIN", "is required on Vercel");
  } else if (!sessionSecret) {
    sessionSecret = randomBytes(32).toString("hex");
    console.warn("SESSION_SECRET is not set; using a random secret for this process only.");
  }

  const publicOrigin = parseOrigin("PUBLIC_ORIGIN", env.PUBLIC_ORIGIN ?? "http://127.0.0.1:3010");

  return Object.freeze({ ...numbers, publicOrigin, sessionSecret, onVercel, fixturesEnabled });
}

let cached: Config | undefined;

/** Server-only accessor. Reads process.env once per process. */
export function getConfig(): Config {
  cached ??= loadConfig(process.env);
  return cached;
}

/** Test hook: replace or clear the cached configuration. */
export function setConfigForTests(config: Config | undefined): void {
  cached = config;
}
