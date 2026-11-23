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
  /** "Notify me" signups per network per hour (POST /api/notify). */
  readonly notifyPerClientHour: number;
  /** Sign-in links per network per hour (POST /api/auth/sign-in). */
  readonly signInPerClientHour: number;
  /** Sign-in links per email address per hour; the window is keyed by a keyed hash of the address. */
  readonly signInPerEmailHour: number;
  readonly staleAfterS: number;
  readonly analysisTtlS: number;
  readonly scoreWaitMs: number;
  readonly publicOrigin: string;
  readonly sessionSecret: string;
  readonly onVercel: boolean;
  readonly fixturesEnabled: boolean;
  /**
   * The instant billing and the free-analysis limit start (ms since epoch; BILLING_START, default
   * 2027-01-19T00:00:00Z, the day after judging ends). Before it every visitor keeps open access.
   */
  readonly billingStart: number;
  /** Phase 6: Retrofit's free inference path. */
  readonly free: FreeConfig;
  /** Phase 7: the Supabase store. Required on Vercel; null off Vercel without it (memory store). */
  readonly supabase: SupabaseConfig | null;
  /**
   * SUPABASE_ANON_KEY: the anon key that sign-in uses for Supabase Auth (server side only; it never
   * reaches a browser). Required on Vercel; null off Vercel without it (sign-in then answers 503).
   */
  readonly supabaseAnonKey: string | null;
}

export interface SupabaseConfig {
  readonly url: string;
  /** Server only. Never sent to a browser, logged or written to evidence. */
  readonly serviceRoleKey: string;
}

export interface FreeConfig {
  readonly model: string;
  /** USD per million input and output tokens, from the Otari model list. */
  readonly priceInPerM: number;
  readonly priceOutPerM: number;
  /** USD added to every reservation when the provider lists a per-request fee. */
  readonly perRequestFeeUsd: number;
  readonly creditUsd: number;
  readonly judgeReserveUsd: number;
  /** End of the free period (ms since epoch), for the public daily budget. */
  readonly serviceEndMs: number;
  readonly maxTokens: number;
  readonly maxBodyBytes: number;
  readonly framingTokensPerMessage: number;
  readonly framingTokensBase: number;
  readonly maxMessages: number;
  readonly maxTools: number;
  readonly maxToolBytes: number;
  readonly inflightPerSession: number;
  readonly inflightGlobal: number;
  readonly callsPerSession: number;
  readonly sessionsPerClientHour: number;
  readonly judgeCallsPerSession: number;
  readonly judgeSessionsPerClientDay: number;
  readonly upstreamTimeoutMs: number;
  /** Fractions of the credit that raise one alert each, ascending. */
  readonly alertThresholds: readonly number[];
  /** OpenAI-compatible base URL of the provider (Otari), chosen by OTARI_REGION. FREE_UPSTREAM_URL overrides it off Vercel only (tests). */
  readonly upstreamUrl: string;
  /** Server keys per pool. One key serves both when Otari has no per-key limits (qualified guarantee). */
  readonly keyPublic: string | null;
  readonly keyJudge: string | null;
  readonly judgeCode: string | null;
  readonly cronSecret: string | null;
  readonly alertGithubToken: string | null;
  readonly alertRepo: string;
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
  notifyPerClientHour: ["NOTIFY_PER_CLIENT_HOUR", 5],
  signInPerClientHour: ["SIGNIN_PER_CLIENT_HOUR", 5],
  signInPerEmailHour: ["SIGNIN_PER_EMAIL_HOUR", 3],
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
  // A crawl starts no request after its budget (the pacer checks the time after every store call and
  // wait), and a request is aborted FETCH_TIMEOUT_MS after it starts, so every request ends within
  // CRAWL_BUDGET_MS + FETCH_TIMEOUT_MS of the crawl's start (fetch/crawl.ts). The job lease is taken
  // a few store calls before that start and renewed before each later page, so this bound keeps
  // every request inside the lease except for those calls and the time to handle the abort; the
  // defaults leave 7 s for them. FETCH_TIMEOUT_MS is positive, so it also keeps CRAWL_BUDGET_MS
  // below CRAWL_LEASE_TTL_S * 1000.
  if (numbers.crawlBudgetMs + numbers.fetchTimeoutMs > numbers.crawlLeaseTtlS * 1000) {
    throw new ConfigError("CRAWL_BUDGET_MS", "CRAWL_BUDGET_MS + FETCH_TIMEOUT_MS must be at most CRAWL_LEASE_TTL_S * 1000");
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

  const free = loadFreeConfig(env, onVercel);
  if (free.upstreamTimeoutMs > 50_000) throw new ConfigError("FREE_UPSTREAM_TIMEOUT_MS", "must be at most 50000 (maxDuration 60 s)");

  const supabase = loadSupabaseConfig(env, onVercel);
  const supabaseAnonKey = env.SUPABASE_ANON_KEY?.trim() || null;
  if (onVercel && !supabaseAnonKey) throw new ConfigError("SUPABASE_ANON_KEY", "is required on Vercel");
  if (supabaseAnonKey && !supabase) throw new ConfigError("SUPABASE_URL", "is required when SUPABASE_ANON_KEY is set");

  const billingStart = parseInstant(env, "BILLING_START", "2027-01-19T00:00:00Z");

  return Object.freeze({ ...numbers, publicOrigin, sessionSecret, onVercel, fixturesEnabled, billingStart, free, supabase, supabaseAnonKey });
}

/** SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY: required on Vercel (https); off Vercel both or neither. */
function loadSupabaseConfig(env: Env, onVercel: boolean): SupabaseConfig | null {
  const rawUrl = env.SUPABASE_URL?.trim() || null;
  const key = env.SUPABASE_SERVICE_ROLE_KEY?.trim() || null;
  if (onVercel && !rawUrl) throw new ConfigError("SUPABASE_URL", "is required on Vercel");
  if (onVercel && !key) throw new ConfigError("SUPABASE_SERVICE_ROLE_KEY", "is required on Vercel");
  if (rawUrl && !key) throw new ConfigError("SUPABASE_SERVICE_ROLE_KEY", "is required when SUPABASE_URL is set");
  if (key && !rawUrl) throw new ConfigError("SUPABASE_URL", "is required when SUPABASE_SERVICE_ROLE_KEY is set");
  if (!rawUrl || !key) return null;
  const url = parseOrigin("SUPABASE_URL", rawUrl);
  if (onVercel && !url.startsWith("https:")) throw new ConfigError("SUPABASE_URL", "must use https on Vercel");
  return Object.freeze({ url, serviceRoleKey: key });
}

/** An ISO 8601 date and time in ms since the epoch; `fallback` when unset. */
function parseInstant(env: Env, name: string, fallback: string): number {
  const ms = Date.parse(env[name] ?? fallback);
  if (!Number.isFinite(ms)) throw new ConfigError(name, "must be an ISO date and time");
  return ms;
}

function parseNonNegative(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  if (!/^\d+(\.\d+)?$/.test(raw.trim())) throw new ConfigError(name, `must be a non-negative number, got "${raw}"`);
  return Number(raw);
}

/** Off Vercel, placeholder amounts keep local development and tests running; Vercel requires the real values. */
const LOCAL_FREE_DEFAULTS = { FREE_PRICE_IN_PER_M: 0.1, FREE_PRICE_OUT_PER_M: 0.4, FREE_CREDIT_USD: 10, JUDGE_RESERVE_USD: 3 } as const;

/** Otari's OpenAI-compatible base URL per account region (OTARI_REGION). */
const OTARI_HOSTS = { us: "https://api.otari.ai/api/v1", eu: "https://eu.api.otari.ai/api/v1" } as const;

export function loadFreeConfig(env: Env, onVercel: boolean): FreeConfig {
  const required = (name: keyof typeof LOCAL_FREE_DEFAULTS): number => {
    if (onVercel && !env[name]) throw new ConfigError(name, "is required on Vercel");
    return parsePositive(env, name, LOCAL_FREE_DEFAULTS[name]);
  };
  const secret = (name: string): string | null => {
    const v = env[name]?.trim();
    if (onVercel && !v) throw new ConfigError(name, "is required on Vercel");
    return v || null;
  };
  const priceInPerM = required("FREE_PRICE_IN_PER_M");
  const priceOutPerM = required("FREE_PRICE_OUT_PER_M");
  const creditUsd = required("FREE_CREDIT_USD");
  const judgeReserveUsd = required("JUDGE_RESERVE_USD");
  if (judgeReserveUsd >= creditUsd) throw new ConfigError("JUDGE_RESERVE_USD", "must be less than FREE_CREDIT_USD");

  const serviceEndMs = parseInstant(env, "FREE_SERVICE_END", "2027-01-18T23:59:59Z");

  const thresholds = (env.CREDIT_ALERT_THRESHOLDS ?? "0.5,0.8,0.95").split(",").map((x) => Number(x.trim()));
  if (!thresholds.length || thresholds.some((t, i) => !(t > 0 && t < 1) || (i > 0 && t <= thresholds[i - 1]!))) {
    throw new ConfigError("CREDIT_ALERT_THRESHOLDS", "must be ascending fractions between 0 and 1");
  }

  // An Otari key works only on its account's regional host; another host answers 421.
  const region = env.OTARI_REGION?.trim();
  if (onVercel && !region) throw new ConfigError("OTARI_REGION", "is required on Vercel (us or eu)");
  if (region && !Object.hasOwn(OTARI_HOSTS, region)) throw new ConfigError("OTARI_REGION", `must be us or eu, got "${region}"`);
  if (onVercel && env.FREE_UPSTREAM_URL) throw new ConfigError("FREE_UPSTREAM_URL", "must not be set on Vercel");
  const upstreamUrl = (env.FREE_UPSTREAM_URL ?? OTARI_HOSTS[(region ?? "us") as keyof typeof OTARI_HOSTS]).replace(/\/$/, "");
  try {
    const u = new URL(upstreamUrl);
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error();
  } catch {
    throw new ConfigError("FREE_UPSTREAM_URL", "must be an http or https URL");
  }

  // Either one key for both pools, or one per pool (provider-backed isolation).
  const single = env.OTARI_API_KEY?.trim() || null;
  const keyPublic = env.OTARI_API_KEY_PUBLIC?.trim() || single;
  const keyJudge = env.OTARI_API_KEY_JUDGE?.trim() || single;
  if (onVercel && (!keyPublic || !keyJudge)) throw new ConfigError("OTARI_API_KEY", "is required on Vercel (or OTARI_API_KEY_PUBLIC and OTARI_API_KEY_JUDGE)");

  const judgeCode = secret("JUDGE_CODE");
  if (onVercel && judgeCode && judgeCode.length < 16) throw new ConfigError("JUDGE_CODE", "must be at least 16 characters on Vercel");

  const n = (name: string, fallback: number) => parsePositive(env, name, fallback);
  return Object.freeze({
    model: env.FREE_MODEL?.trim() || "alibaba/qwen3.8-flash",
    priceInPerM,
    priceOutPerM,
    perRequestFeeUsd: parseNonNegative(env, "FREE_PER_REQUEST_FEE_USD", 0),
    creditUsd,
    judgeReserveUsd,
    serviceEndMs,
    maxTokens: n("FREE_MAX_TOKENS", 1024),
    maxBodyBytes: n("FREE_MAX_BODY_BYTES", 98304),
    framingTokensPerMessage: n("FREE_FRAMING_TOKENS_PER_MESSAGE", 16),
    framingTokensBase: n("FREE_FRAMING_TOKENS_BASE", 512),
    maxMessages: n("FREE_MAX_MESSAGES", 80),
    maxTools: n("FREE_MAX_TOOLS", 16),
    maxToolBytes: n("FREE_MAX_TOOL_BYTES", 4096),
    inflightPerSession: n("FREE_INFLIGHT_PER_SESSION", 2),
    inflightGlobal: n("FREE_INFLIGHT_GLOBAL", 16),
    callsPerSession: n("FREE_CALLS_PER_SESSION", 40),
    sessionsPerClientHour: n("FREE_SESSIONS_PER_CLIENT_HOUR", 6),
    judgeCallsPerSession: n("JUDGE_CALLS_PER_SESSION", 200),
    judgeSessionsPerClientDay: n("JUDGE_SESSIONS_PER_CLIENT_DAY", 3),
    upstreamTimeoutMs: n("FREE_UPSTREAM_TIMEOUT_MS", 45000),
    alertThresholds: Object.freeze(thresholds),
    upstreamUrl,
    keyPublic,
    keyJudge,
    judgeCode,
    cronSecret: secret("CRON_SECRET"),
    alertGithubToken: secret("ALERT_GITHUB_TOKEN"),
    alertRepo: "juan294/retrofit",
  });
}

let cached: Config | undefined;

/** Server-only accessor. Reads process.env once per process. */
export function getConfig(): Config {
  cached ??= loadConfig(process.env);
  return cached;
}
