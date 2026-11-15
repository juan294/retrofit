import robotsParser from "robots-parser";
import { type Clock, systemClock } from "@/lib/store/types";
import { CrawlDelayTooLong, NotPublicError, RobotsBlocked, RobotsUnavailable } from "./errors";
import { rawGuardedGet, type RawFetchContext, type RobotsChecker } from "./http";

export const ROBOTS_AGENT = "RetrofitBot";
export const ROBOTS_TTL_S = 3600;
/** RFC 9309 asks crawlers to parse at least 500 KiB. */
const MAX_ROBOTS_CHARS = 512 * 1024;

type RobotsRecord = { readonly kind: "rules"; readonly text: string } | { readonly kind: "allow" } | { readonly kind: "unavailable"; readonly retryAt: number };

export type RobotsDeps = RawFetchContext & { readonly clock?: Clock };

export type Robots = RobotsChecker;

/**
 * Store key of one origin's robots record. Robots rules apply to one scheme
 * and authority (RFC 9309 section 2.3), so http://example.test and
 * https://example.test have separate records. `origin` is `URL.origin`.
 */
export const robotsKey = (origin: string) => `robots:${origin}`;

/**
 * robots.txt per origin for RetrofitBot. Results (rules, allow-all, or
 * unavailable with a retry time) are cached in the Store under
 * robots:<origin> for one hour, so every server instance shares them. The
 * robots.txt request goes through the same guarded, paced path without a
 * robots check of its own. Pacing stays per host (see pacing.ts), the stricter
 * choice when two schemes of one host both ask for a delay.
 */
export function createRobots(deps: RobotsDeps): Robots {
  const clock = deps.clock ?? systemClock;
  const inflight = new Map<string, Promise<RobotsRecord>>();
  // Every hop calls check() and then crawlDelay() on the same text; keep the last parse.
  // A Crawl-delay applies from the robots.txt request on: the pacer measures it from the host's latest request.
  let last: { readonly robotsUrl: string; readonly text: string; readonly rules: ReturnType<typeof robotsParser> } | undefined;

  /** Parsed rules for `text` at `robotsUrl` (robots-parser answers only for that URL's own origin). */
  function rulesFor(text: string, robotsUrl: string): ReturnType<typeof robotsParser> {
    if (last && last.text === text && last.robotsUrl === robotsUrl) return last.rules;
    last = { robotsUrl, text, rules: robotsParser(robotsUrl, text) };
    return last.rules;
  }

  async function fetchRecord(url: URL, notAfter: number | undefined): Promise<RobotsRecord> {
    try {
      const res = await rawGuardedGet(new URL("/robots.txt", url.origin), deps, { anyContentType: true, notAfter });
      if (res.status >= 200 && res.status < 300) return { kind: "rules", text: (res.body ?? "").slice(0, MAX_ROBOTS_CHARS) };
      if (res.status >= 400 && res.status < 500) return { kind: "allow" };
      return { kind: "unavailable", retryAt: clock() + ROBOTS_TTL_S * 1000 };
    } catch (e) {
      // Not public, or no time left for the request: nothing was learned, so nothing is cached.
      if (e instanceof NotPublicError || e instanceof CrawlDelayTooLong) throw e;
      return { kind: "unavailable", retryAt: clock() + ROBOTS_TTL_S * 1000 };
    }
  }

  async function load(url: URL, notAfter: number | undefined): Promise<RobotsRecord> {
    const key = robotsKey(url.origin);
    const cached = await deps.store.get<RobotsRecord>(key);
    if (cached && !(cached.kind === "unavailable" && clock() >= cached.retryAt)) return cached;
    let pending = inflight.get(key);
    if (!pending) {
      pending = fetchRecord(url, notAfter).then(async (record) => {
        await deps.store.set(key, record, ROBOTS_TTL_S);
        return record;
      });
      pending.finally(() => inflight.delete(key)).catch(() => {});
      inflight.set(key, pending);
    }
    return pending;
  }

  return {
    async check(url, opts) {
      const record = await load(url, opts?.notAfter);
      if (record.kind === "unavailable") throw new RobotsUnavailable(url.host, new Date(record.retryAt));
      if (record.kind === "rules" && rulesFor(record.text, `${url.origin}/robots.txt`).isAllowed(url.href, ROBOTS_AGENT) === false) {
        throw new RobotsBlocked(url.host);
      }
    },
    async crawlDelay(origin) {
      const record = await deps.store.get<RobotsRecord>(robotsKey(origin));
      if (record?.kind !== "rules") return undefined;
      return rulesFor(record.text, `${origin}/robots.txt`).getCrawlDelay(ROBOTS_AGENT);
    },
  };
}
