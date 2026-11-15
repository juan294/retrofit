import robotsParser from "robots-parser";
import { type Clock, systemClock } from "@/lib/store/types";
import { NotPublicError, RobotsBlocked, RobotsUnavailable } from "./errors";
import { MAX_CRAWL_DELAY_S, rawGuardedGet, type RawFetchContext, type RobotsChecker } from "./http";

export const ROBOTS_AGENT = "RetrofitBot";
export const ROBOTS_TTL_S = 3600;
/** RFC 9309 asks crawlers to parse at least 500 KiB. */
const MAX_ROBOTS_CHARS = 512 * 1024;

type RobotsRecord = { readonly kind: "rules"; readonly text: string } | { readonly kind: "allow" } | { readonly kind: "unavailable"; readonly retryAt: number };

export type RobotsDeps = RawFetchContext & { readonly clock?: Clock };

export type Robots = RobotsChecker;

const keyFor = (host: string) => `robots:${host}`;

/**
 * robots.txt per host for RetrofitBot. Results (rules, allow-all, or
 * unavailable with a retry time) are cached in the Store under robots:<host>
 * for one hour, so every server instance shares them. The robots.txt request
 * goes through the same guarded, paced path without a robots check of its own.
 */
export function createRobots(deps: RobotsDeps): Robots {
  const clock = deps.clock ?? systemClock;
  const inflight = new Map<string, Promise<RobotsRecord>>();
  // Every hop calls check() and then crawlDelay() on the same text; keep the last parse.
  let last: { readonly robotsUrl: string; readonly text: string; readonly rules: ReturnType<typeof robotsParser> } | undefined;

  /** Parsed rules for `text`. isAllowed answers only for the robots URL's own origin; getCrawlDelay accepts a parse for any origin. */
  function rulesFor(text: string, robotsUrl: string, anyOrigin = false): ReturnType<typeof robotsParser> {
    if (last && last.text === text && (anyOrigin || last.robotsUrl === robotsUrl)) return last.rules;
    last = { robotsUrl, text, rules: robotsParser(robotsUrl, text) };
    return last.rules;
  }

  async function fetchRecord(url: URL): Promise<RobotsRecord> {
    try {
      const res = await rawGuardedGet(new URL(`${url.protocol}//${url.host}/robots.txt`), deps, { anyContentType: true });
      if (res.status >= 200 && res.status < 300) return { kind: "rules", text: (res.body ?? "").slice(0, MAX_ROBOTS_CHARS) };
      if (res.status >= 400 && res.status < 500) return { kind: "allow" };
      return { kind: "unavailable", retryAt: clock() + ROBOTS_TTL_S * 1000 };
    } catch (e) {
      if (e instanceof NotPublicError) throw e;
      return { kind: "unavailable", retryAt: clock() + ROBOTS_TTL_S * 1000 };
    }
  }

  async function load(url: URL): Promise<RobotsRecord> {
    const key = keyFor(url.host);
    const cached = await deps.store.get<RobotsRecord>(key);
    if (cached && !(cached.kind === "unavailable" && clock() >= cached.retryAt)) return cached;
    let pending = inflight.get(key);
    if (!pending) {
      pending = fetchRecord(url).then(async (record) => {
        await deps.store.set(key, record, ROBOTS_TTL_S);
        // The robots.txt request itself was paced without the crawl delay. Reserve
        // the host's next slot with it, so the request after robots.txt waits too.
        if (record.kind === "rules") {
          const delay = rulesFor(record.text, `${url.origin}/robots.txt`).getCrawlDelay(ROBOTS_AGENT);
          if (delay && delay > 1) await deps.pace(url.host, Math.min(delay, MAX_CRAWL_DELAY_S));
        }
        return record;
      });
      pending.finally(() => inflight.delete(key)).catch(() => {});
      inflight.set(key, pending);
    }
    return pending;
  }

  return {
    async check(url) {
      const record = await load(url);
      if (record.kind === "unavailable") throw new RobotsUnavailable(url.host, new Date(record.retryAt));
      if (record.kind === "rules" && rulesFor(record.text, `${url.origin}/robots.txt`).isAllowed(url.href, ROBOTS_AGENT) === false) {
        throw new RobotsBlocked(url.host);
      }
    },
    async crawlDelay(host) {
      const record = await deps.store.get<RobotsRecord>(keyFor(host));
      if (record?.kind !== "rules") return undefined;
      return rulesFor(record.text, `http://${host}/robots.txt`, true).getCrawlDelay(ROBOTS_AGENT);
    },
  };
}
