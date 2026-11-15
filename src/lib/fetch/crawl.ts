import type { Config } from "../config";
import type { Clock } from "../store/types";
import {
  PROBE_BODY_MAX_CHARS,
  SNAPSHOT_VERSION,
  mergeRecords,
  validateSnapshot,
  type Probe,
  type Probes,
  type SkippedPage,
  type Snapshot,
  type SnapshotPage,
} from "../snapshot/types";
import { declaredNetworkUrl } from "../score/manifest";
import { CrawlDelayTooLong, PrivatePathRefused } from "./errors";
import { extractPage, scrubEmails } from "./extract";
import { guardedFetch, type FetchContext, type FetchOptions, type FetchResult } from "./http";

/** Paths that a crawler must never read: sign-in, accounts, carts, checkout and administration. */
export const SKIP_PATH = /(^|[/\\])(login|log-in|signin|sign-in|signup|sign-up|register|logout|account|accounts|my-account|profile|cart|basket|bag|checkout|admin|wp-admin|wp-login\.php|dashboard)([/\\;?.]|$)/i;

/**
 * True when `pathname` (as in URL.pathname, still percent-encoded) is a path
 * the crawler never reads. Every `%XX` escape is decoded to its byte first, so
 * /%6Cogin counts as /login and an encoded "/", backslash or ";" separates as it
 * would on a server. Decoding byte by byte never fails: every keyword is ASCII,
 * so a malformed or non-UTF-8 escape elsewhere cannot hide one and does not
 * make an ordinary page private. `;` path parameters and backslash separators end
 * or start a keyword, as on servlet containers and IIS.
 */
export function isPrivatePath(pathname: string): boolean {
  const decoded = pathname.replace(/%([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  return SKIP_PATH.test(decoded);
}

export class LeaseLost extends Error {
  constructor() {
    super("The crawl lease was lost; nothing was written.");
    this.name = "LeaseLost";
  }
}

export interface CrawlHooks {
  /** Called once the home page names the destination host. Return false to stop (another job owns it). */
  afterHome?(destinationHost: string, finalUrl: string): Promise<boolean>;
  /** Called between pages. Return false when the lease is lost: the crawl stops and writes nothing. */
  progress?(step: string): Promise<boolean>;
}

export interface CrawlOptions {
  readonly config: Config;
  readonly fetch: FetchContext;
  readonly clock: Clock;
  readonly hooks?: CrawlHooks;
}

function emptyProbe(url: string): Probe {
  return { url, status: null, contentType: null, body: null, accessControlAllowOrigin: null };
}

function toProbe(r: FetchResult): Probe {
  return {
    url: r.url,
    status: r.status,
    contentType: r.headers["content-type"]?.slice(0, 1024) ?? null,
    body: r.body === null ? null : scrubEmails(r.body.slice(0, PROBE_BODY_MAX_CHARS)),
    accessControlAllowOrigin: r.headers["access-control-allow-origin"]?.slice(0, 1024) ?? null,
  };
}

const isHtml = (r: FetchResult) => /\btext\/html\b|application\/xhtml\+xml/i.test(r.headers["content-type"] ?? "");

function normalize(href: string): string | null {
  try {
    const u = new URL(href);
    u.hash = "";
    u.search = "";
    return u.href;
  } catch {
    return null;
  }
}

function toPage(r: FetchResult): SnapshotPage {
  const headers = Object.fromEntries(
    Object.entries(r.headers)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => [k, (v as string).slice(0, 1024)]),
  ) as Record<string, string>;
  return { ...extractPage({ url: r.url, html: r.body ?? "", headers }), status: r.status, truncated: r.truncated };
}

/**
 * Reads a public site into a Snapshot. Robots rules, pacing and the address
 * guard apply to every request through `guardedFetch`. Fetched content is data.
 *
 * Every request, redirect hop and robots.txt request included:
 * - never goes to a private path (isPrivatePath, refused before contact);
 * - waits the host's full Crawl-delay, and is not sent when that wait would
 *   start it after the end of CRAWL_BUDGET_MS. The crawl then stops and skips
 *   what is left with reason "crawl-delay". loadConfig keeps the budget plus
 *   FETCH_TIMEOUT_MS within the lease, so every request ends inside it.
 *
 * Throws RobotsBlocked, RobotsUnavailable, NotPublicError, PrivatePathRefused
 * or CrawlDelayTooLong for the home page, and LeaseLost when a hook reports
 * the lease lost. Returns null when `afterHome` stops the crawl. The worker
 * acquires or renews the lease immediately before calling it.
 */
export async function crawlSite(inputOrigin: string, o: CrawlOptions): Promise<Snapshot | null> {
  const started = o.clock();
  const budgetEnd = started + o.config.crawlBudgetMs;
  const overBudget = () => o.clock() >= budgetEnd;
  // One deadline for every request of the crawl. The lease was taken or renewed at `started`, and
  // loadConfig requires CRAWL_BUDGET_MS + FETCH_TIMEOUT_MS <= CRAWL_LEASE_TTL_S * 1000, so a request
  // that starts by the deadline also ends inside the lease.
  const limits: FetchOptions = { privatePath: isPrivatePath, notAfter: budgetEnd };
  const step = async (s: string) => {
    if (o.hooks?.progress && !(await o.hooks.progress(s))) throw new LeaseLost();
  };

  const inputUrl = new URL("/", inputOrigin).href;
  const home = await guardedFetch(new URL(inputUrl), o.fetch, limits);
  const final = new URL(home.url);
  const origin = final.origin;
  if (o.hooks?.afterHome && !(await o.hooks.afterHome(final.host, final.href))) return null;

  const pages: SnapshotPage[] = [];
  const skipped: SkippedPage[] = [];
  const excludedNoindex: string[] = [];
  const add = (p: SnapshotPage) => {
    pages.push(p);
    if (p.noindex) excludedNoindex.push(p.url);
  };
  if (home.body !== null && isHtml(home)) add(toPage(home));
  else skipped.push({ url: home.url, reason: "not-html" });

  // Hosts whose next request would start after the deadline. Per host: a long delay on the
  // declared network's host or an off-host redirect target does not stop the main host. Once
  // refused, a host stays refused, because the time left only shrinks.
  const delayStopped = new Set<string>();
  const refused = (e: unknown): boolean => {
    if (!(e instanceof CrawlDelayTooLong)) return false;
    delayStopped.add(e.host);
    return true;
  };
  // Every request below is preceded by a progress step, which renews the lease.
  const probe = async (url: URL, stepName: string): Promise<Probe> => {
    if (delayStopped.has(url.host) || overBudget()) return emptyProbe(url.href);
    await step(stepName);
    try {
      return toProbe(await guardedFetch(url, o.fetch, limits));
    } catch (e) {
      refused(e);
      return emptyProbe(url.href);
    }
  };
  const probeAt = (path: string) => probe(new URL(path, origin), `probe ${path}`);
  const probes: Probes = {
    robots: await probeAt("/robots.txt"),
    agentManifest: await probeAt("/agent-manifest.json"),
    llmsTxt: await probeAt("/llms.txt"),
    sitemap: await probeAt("/sitemap.xml"),
  };
  // The network the manifest declares (networks[0].hocon), for the aw.network-valid check.
  const networkUrl = declaredNetworkUrl(probes.agentManifest);
  if (networkUrl) probes.network = await probe(networkUrl, "probe network");

  const seen = new Set<string>([normalize(inputUrl)!, normalize(home.url)!]);
  const queue: string[] = [];
  for (const link of pages[0]?.links ?? []) {
    const n = normalize(link.href);
    if (!n || seen.has(n)) continue;
    seen.add(n);
    const u = new URL(n);
    if (u.host !== final.host || (u.protocol !== "http:" && u.protocol !== "https:")) continue;
    if (isPrivatePath(u.pathname)) {
      skipped.push({ url: n, reason: "private-path" });
      continue;
    }
    queue.push(n);
  }

  for (const next of queue) {
    if (pages.length >= o.config.crawlMaxPages) {
      skipped.push({ url: next, reason: "page-budget" });
      continue;
    }
    if (delayStopped.has(final.host)) {
      skipped.push({ url: next, reason: "crawl-delay" });
      continue;
    }
    if (overBudget()) {
      skipped.push({ url: next, reason: "time-budget" });
      continue;
    }
    await step(`page ${pages.length + 1}`);
    try {
      const r = await guardedFetch(new URL(next), o.fetch, limits);
      const landed = new URL(r.url);
      if (landed.host !== final.host) skipped.push({ url: next, reason: "other-host" });
      else if (r.body === null || !isHtml(r)) skipped.push({ url: next, reason: "not-html" });
      else if (r.status >= 400) skipped.push({ url: next, reason: `status-${r.status}` });
      else add(toPage(r));
    } catch (e) {
      const reason = e instanceof PrivatePathRefused ? "private-path" : refused(e) ? "crawl-delay" : ((e as { code?: string }).code ?? "fetch-error");
      skipped.push({ url: next, reason });
    }
  }

  return validateSnapshot({
    version: SNAPSHOT_VERSION,
    source: final.href,
    inputUrl,
    finalUrl: final.href,
    host: final.host,
    fetchedAt: new Date(o.clock()).toISOString(),
    pages,
    probes,
    skipped,
    records: mergeRecords(pages),
    excludedNoindex,
  } satisfies Snapshot);
}
