import type { Config } from "../config";
import type { Clock } from "../store/types";
import {
  PROBE_BODY_MAX_CHARS,
  SNAPSHOT_VERSION,
  mergeRecords,
  validateSnapshot,
  type Probe,
  type SkippedPage,
  type Snapshot,
  type SnapshotPage,
} from "../snapshot/types";
import { extractPage, scrubEmails } from "./extract";
import { MAX_CRAWL_DELAY_S, guardedFetch, type FetchContext, type FetchResult } from "./http";

export { MAX_CRAWL_DELAY_S };

/** Paths that a crawler must never read: sign-in, accounts, carts, checkout and administration. */
export const SKIP_PATH = /(^|\/)(login|log-in|signin|sign-in|signup|sign-up|register|logout|account|accounts|my-account|profile|cart|basket|bag|checkout|admin|wp-admin|wp-login\.php|dashboard)(\/|$|\.|\?)/i;

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

async function probe(url: URL, ctx: FetchContext): Promise<Probe> {
  try {
    // Through guardedFetch, so each probe (robots.txt included) waits the host's crawl delay.
    return toProbe(await guardedFetch(url, ctx));
  } catch {
    return emptyProbe(url.href);
  }
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
 * Throws RobotsBlocked, RobotsUnavailable or NotPublicError for the home page,
 * and LeaseLost when a hook reports the lease lost. Returns null when
 * `afterHome` stops the crawl.
 */
export async function crawlSite(inputOrigin: string, o: CrawlOptions): Promise<Snapshot | null> {
  const started = o.clock();
  const overBudget = () => o.clock() - started >= o.config.crawlBudgetMs;
  const step = async (s: string) => {
    if (o.hooks?.progress && !(await o.hooks.progress(s))) throw new LeaseLost();
  };

  const inputUrl = new URL("/", inputOrigin).href;
  const home = await guardedFetch(new URL(inputUrl), o.fetch);
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

  // Every request below is preceded by a progress step, which renews the lease.
  const delay = (await o.fetch.robots.crawlDelay(final.host)) ?? 0;
  const slow = delay > MAX_CRAWL_DELAY_S;
  const probeAt = async (path: string): Promise<Probe> => {
    const url = new URL(path, origin);
    if (slow || overBudget()) return emptyProbe(url.href);
    await step(`probe ${path}`);
    return probe(url, o.fetch);
  };
  const probes = {
    robots: await probeAt("/robots.txt"),
    agentManifest: await probeAt("/agent-manifest.json"),
    llmsTxt: await probeAt("/llms.txt"),
    sitemap: await probeAt("/sitemap.xml"),
  };

  const seen = new Set<string>([normalize(inputUrl)!, normalize(home.url)!]);
  const queue: string[] = [];
  for (const link of pages[0]?.links ?? []) {
    const n = normalize(link.href);
    if (!n || seen.has(n)) continue;
    seen.add(n);
    const u = new URL(n);
    if (u.host !== final.host || (u.protocol !== "http:" && u.protocol !== "https:")) continue;
    if (SKIP_PATH.test(u.pathname)) {
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
    if (slow) {
      skipped.push({ url: next, reason: "crawl-delay" });
      continue;
    }
    if (overBudget()) {
      skipped.push({ url: next, reason: "time-budget" });
      continue;
    }
    await step(`page ${pages.length + 1}`);
    try {
      const r = await guardedFetch(new URL(next), o.fetch);
      const landed = new URL(r.url);
      if (landed.host !== final.host) skipped.push({ url: next, reason: "other-host" });
      else if (SKIP_PATH.test(landed.pathname)) skipped.push({ url: next, reason: "private-path" });
      else if (r.body === null || !isHtml(r)) skipped.push({ url: next, reason: "not-html" });
      else if (r.status >= 400) skipped.push({ url: next, reason: `status-${r.status}` });
      else add(toPage(r));
    } catch (e) {
      skipped.push({ url: next, reason: (e as { code?: string }).code ?? "fetch-error" });
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
