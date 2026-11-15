import { Agent, request } from "undici";
import type { Config } from "@/lib/config";
import type { Store } from "@/lib/store/types";
import { FetchTimeoutError, NotPublicError, TooManyRedirects } from "./errors";
import { guardedLookup, resolvePublic, systemResolver, type Resolver } from "./guard";
import { validateUrl } from "./url";

export const MAX_REDIRECTS = 5;
export const KEPT_HEADERS = ["content-type", "x-robots-tag", "access-control-allow-origin"] as const;
export type KeptHeader = (typeof KEPT_HEADERS)[number];

/** Per-host pacing slot. `host` is `URL.host`. */
export type Pace = (host: string, crawlDelaySeconds?: number) => Promise<void>;

/**
 * Longest wait Retrofit makes between two requests to one host. A site that asks
 * for more gets robots.txt and its home page only (see crawl.ts), so the wait
 * never outlasts the worker's lease.
 */
export const MAX_CRAWL_DELAY_S = 10;

/** The robots surface `guardedFetch` needs; `createRobots` returns one. */
export interface RobotsChecker {
  check(url: URL): Promise<void>;
  crawlDelay(host: string): Promise<number | undefined>;
}

export interface FetchContext {
  readonly config: Config;
  readonly store: Pick<Store, "get" | "set">;
  readonly robots: RobotsChecker;
  readonly pace: Pace;
  /** Resolver used before connecting and at connect time. Defaults to the system resolver. */
  readonly lookup?: Resolver;
  /** Overrides the RetrofitBot user agent string. */
  readonly userAgent?: string;
}

/** Context for requests that skip the robots check (robots.txt itself). */
export type RawFetchContext = Omit<FetchContext, "robots">;

export interface RawGetOptions {
  /** Read the body whatever the content type (robots.txt is often served without one). */
  readonly anyContentType?: boolean;
}

export interface FetchResult {
  /** Final URL after redirects. */
  readonly url: string;
  readonly status: number;
  /** Only content-type, x-robots-tag and access-control-allow-origin. */
  readonly headers: Partial<Record<KeptHeader, string>>;
  /** Null when the content type is not HTML, text, XML or JSON. */
  readonly body: string | null;
  /** True when the body was cut at FETCH_MAX_BYTES. */
  readonly truncated: boolean;
  /** Every redirect target followed, in order. */
  readonly redirects: string[];
}

export function retrofitUserAgent(config: Pick<Config, "publicOrigin">): string {
  return `RetrofitBot/0.1 (+${config.publicOrigin}/bot)`;
}

const ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,application/json;q=0.8,*/*;q=0.1";
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

// One Agent per (config, resolver): global fetch ignores a custom lookup, so every
// request goes through undici `request` with this Agent's connect-time guard.
const agents = new WeakMap<Config, WeakMap<Resolver, Agent>>();

function agentFor(config: Config, resolver: Resolver): Agent {
  let byResolver = agents.get(config);
  if (!byResolver) {
    byResolver = new WeakMap();
    agents.set(config, byResolver);
  }
  let agent = byResolver.get(resolver);
  if (!agent) {
    agent = new Agent({
      connect: { lookup: guardedLookup(config, resolver), timeout: config.fetchTimeoutMs },
      headersTimeout: config.fetchTimeoutMs,
      bodyTimeout: config.fetchTimeoutMs,
    });
    byResolver.set(resolver, agent);
  }
  return agent;
}

function headerValue(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v.join(", ") : v;
}

function isReadableType(contentType: string | undefined): boolean {
  if (!contentType) return false;
  const mime = (contentType.split(";")[0] ?? "").trim().toLowerCase();
  return mime.startsWith("text/") || mime === "application/json" || mime.endsWith("+json") || mime === "application/xml" || mime.endsWith("+xml");
}

function decode(bytes: Buffer, contentType: string | undefined): string {
  const charset = /charset=["']?([\w.:-]+)/i.exec(contentType ?? "")?.[1];
  try {
    return new TextDecoder(charset ?? "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

function notPublicCause(e: unknown): NotPublicError | undefined {
  if (e instanceof NotPublicError) return e;
  if (e instanceof Error && e.cause instanceof NotPublicError) return e.cause;
  return undefined;
}

interface HopResult {
  status: number;
  location: string | undefined;
  headers: Partial<Record<KeptHeader, string>>;
  body: string | null;
  truncated: boolean;
}

/** One GET within FETCH_TIMEOUT_MS: headers and body stream share the deadline. */
async function sendOnce(url: URL, ctx: RawFetchContext, resolver: Resolver, opts: RawGetOptions): Promise<HopResult> {
  const { config } = ctx;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.fetchTimeoutMs);
  try {
    const res = await request(url, {
      method: "GET",
      dispatcher: agentFor(config, resolver),
      signal: controller.signal,
      headers: {
        "user-agent": ctx.userAgent ?? retrofitUserAgent(config),
        accept: ACCEPT,
        "accept-encoding": "identity",
      },
    });
    // Destroying the body (redirect, metadata only, truncation) emits an abort error; it is expected.
    res.body.on("error", () => {});
    const headers: Partial<Record<KeptHeader, string>> = {};
    for (const name of KEPT_HEADERS) {
      const v = headerValue(res.headers[name]);
      if (v !== undefined) headers[name] = v;
    }
    const location = headerValue(res.headers.location);
    if ((REDIRECT_STATUS.has(res.statusCode) && location) || !(opts.anyContentType || isReadableType(headers["content-type"]))) {
      res.body.destroy();
      return { status: res.statusCode, location, headers, body: null, truncated: false };
    }
    const max = config.fetchMaxBytes;
    const chunks: Buffer[] = [];
    let total = 0;
    let truncated = false;
    for await (const chunk of res.body as AsyncIterable<Buffer>) {
      chunks.push(chunk);
      total += chunk.length;
      if (total > max) {
        truncated = true;
        break;
      }
    }
    const bytes = Buffer.concat(chunks).subarray(0, max);
    return { status: res.statusCode, location, headers, body: decode(bytes, headers["content-type"]), truncated };
  } catch (e) {
    const np = notPublicCause(e);
    if (np) throw np;
    if (controller.signal.aborted) throw new FetchTimeoutError(url.href);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Each hop: address check, robots (when given), pacing slot, then the request.
 * Redirect targets are re-validated with validateUrl; at most MAX_REDIRECTS hops.
 */
async function follow(start: URL, ctx: RawFetchContext, robots: RobotsChecker | null, opts: RawGetOptions): Promise<FetchResult> {
  const resolver = ctx.lookup ?? systemResolver;
  const redirects: string[] = [];
  let current = start;
  for (;;) {
    await resolvePublic(current.hostname, ctx.config, resolver);
    let crawlDelay: number | undefined;
    if (robots) {
      await robots.check(current);
      crawlDelay = await robots.crawlDelay(current.host);
    }
    await ctx.pace(current.host, crawlDelay === undefined ? undefined : Math.min(crawlDelay, MAX_CRAWL_DELAY_S));
    const hop = await sendOnce(current, ctx, resolver, opts);
    if (REDIRECT_STATUS.has(hop.status) && hop.location) {
      if (redirects.length >= MAX_REDIRECTS) throw new TooManyRedirects(start.href);
      let target: URL;
      try {
        target = new URL(hop.location, current);
      } catch {
        throw new NotPublicError("invalid redirect target");
      }
      current = validateUrl(target.href, ctx.config);
      redirects.push(current.href);
      continue;
    }
    return { url: current.href, status: hop.status, headers: hop.headers, body: hop.body, truncated: hop.truncated, redirects };
  }
}

/**
 * Guarded GET without any robots check. Used for robots.txt itself.
 * Still applies validateUrl, the address guard (before and at connect time),
 * pacing, limits and redirect re-validation.
 */
export async function rawGuardedGet(url: URL, ctx: RawFetchContext, opts: RawGetOptions = {}): Promise<FetchResult> {
  return follow(validateUrl(url.href, ctx.config), ctx, null, opts);
}

/**
 * Reads one public URL: guarded lookup, robots per host, pacing per host,
 * RetrofitBot UA, no cookies, manual redirects (each hop re-validated),
 * body cut at FETCH_MAX_BYTES, FETCH_TIMEOUT_MS per request.
 * Throws NotPublicError, RobotsBlocked, RobotsUnavailable, FetchTimeoutError or TooManyRedirects.
 */
export async function guardedFetch(url: URL, ctx: FetchContext): Promise<FetchResult> {
  return follow(validateUrl(url.href, ctx.config), ctx, ctx.robots, {});
}
