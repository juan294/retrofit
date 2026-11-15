/**
 * Every text a visitor or an agent reads from the analysis and score routes.
 * Visitor texts are the parent plan's stuck-state table, verbatim
 * (docs/plans/2026-11-15-retrofit-url-to-preview.md "Stuck states and recovery").
 * Agent texts are the score tool contract's Surface 1 table, verbatim
 * (docs/research/score-tool-contract.md "Failures").
 *
 * Times in visitor texts are written "HH:MM UTC"; every response with such a
 * text also carries `retryAt` (ISO 8601) so a page can show local time.
 */

/** HH:MM in UTC. */
export function hhmmUtc(at: Date): string {
  return at.toISOString().slice(11, 16);
}

const DATE = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

/**
 * Seconds until a caller retries an undecided count (`counting`): the server's
 * retryAfterSeconds and the page's own retry wait. The texts below say "a few
 * seconds" and "2 seconds".
 */
export const COUNTING_RETRY_S = 2;

export const visitorTexts = {
  stale: "This analysis took too long. Try again.",
  robotsBlocked: "This site asks automated tools not to read it. Retrofit stopped and read nothing else.",
  robotsUnavailable: (retryAt: Date) => `Retrofit could not read this site's robots rules, so it stopped. Try again after ${hhmmUtc(retryAt)} UTC.`,
  clientLimit: (limit: number, retryAt: Date) => `You reached the limit of ${limit} analyses per hour. Try again at ${hhmmUtc(retryAt)} UTC.`,
  queued: "Retrofit is busy. Your analysis starts in a moment.",
  dailyLimit: "Retrofit reached today's analysis limit. Try again tomorrow.",
  queueExpired: "Retrofit is too busy right now. Try again in a few minutes.",
  notPublic: "This address is not a public website.",
  crawlError: "Retrofit could not read this site.",
  expired: (expiresAt: Date) => `This preview expired on ${DATE.format(expiresAt)}. Analyze the site again.`,
  otherBrowser: "This preview belongs to another browser. Analyze the site again to get your own.",
  generationFailed: "Retrofit could not build a working agent for this site.",
  unavailable: "Retrofit is having trouble. Try again in a few minutes.",
  // Not in the plan table: the same-origin precondition of POST /api/analyze.
  crossOrigin: "Open Retrofit at its own address and paste the website address there.",
  // Not in the plan table: a POST /api/analyze body over 8 KB.
  tooLarge: "Send only the website address.",
  // Not in the plan table: the site's daily count is still undecided (another request for it is starting).
  counting: "Retrofit is still starting another analysis of this site. Try again in a few seconds.",
  // Not in the plan table: shown while the page retries a counting answer by itself.
  countingRetry: "Retrofit is still starting another analysis of this site. Trying again in a moment.",
} as const;

/** Visitor text for a failure code from a crawl job or the analysis routes. Unknown codes get the generic text. */
export function visitorFailure(code: string, o: { retryAt?: Date } = {}): string {
  switch (code) {
    case "stale":
      return visitorTexts.stale;
    case "robots_blocked":
      return visitorTexts.robotsBlocked;
    case "robots_unavailable":
      return o.retryAt ? visitorTexts.robotsUnavailable(o.retryAt) : visitorTexts.unavailable;
    case "not_public":
      return visitorTexts.notPublic;
    case "crawl_error":
      return visitorTexts.crawlError;
    case "queue_expired":
      return visitorTexts.queueExpired;
    case "daily_limit":
      return visitorTexts.dailyLimit;
    case "counting":
      return visitorTexts.counting;
    default:
      return visitorTexts.unavailable;
  }
}

export type AgentErrorCode =
  | "missing_url"
  | "invalid_url"
  | "not_public"
  | "robots_blocked"
  | "robots_unavailable"
  | "crawl_error"
  | "stale"
  | "queue_expired"
  | "client_limit"
  | "daily_limit"
  | "unavailable"
  | "method_not_allowed";

/** `{retryTime}` and `{retryMinutes}` as the contract defines them. */
function retryParts(retryAfterSeconds: number, retryAt: Date) {
  return { time: hhmmUtc(retryAt), minutes: Math.ceil(retryAfterSeconds / 60) };
}

export const agentTexts = {
  running: "The score is still running. Call again in 20 seconds with the same URL.",
  missing_url: "Add the website address in the url query parameter, such as /api/score?url=https%3A%2F%2Fexample.com.",
  invalid_url:
    "The url is not a website address. Pass one public http or https address, such as https://example.com, with no user name or password and at most 2048 characters.",
  not_public:
    "This address is not a public website. Retrofit scores only public sites on the standard ports, not IP addresses, local names or private networks, and the name must exist in DNS. Check the spelling with the user or ask for another address.",
  robots_blocked:
    "This site asks automated tools not to read it. Retrofit stopped and read nothing else. Do not call again for this site. Its owner can allow RetrofitBot in robots.txt.",
  robots_unavailable: (retryAfterSeconds: number, retryAt: Date) => {
    const r = retryParts(retryAfterSeconds, retryAt);
    return `Retrofit could not read this site's robots rules, so it stopped. Call again after ${r.time} UTC (in ${r.minutes} minutes) with the same URL.`;
  },
  crawl_error:
    "Retrofit could not read this site. It did not answer in time, redirected too many times or refused the connection. Check that the address opens in a browser. If the site works only over http, call again once with an address that starts with http://.",
  stale: "This score took too long. Call again now with the same URL to start a new one.",
  queue_expired: "Retrofit is too busy right now. Try again in a few minutes.",
  client_limit: (limit: number, retryAfterSeconds: number, retryAt: Date) => {
    const r = retryParts(retryAfterSeconds, retryAt);
    return `This client reached the limit of ${limit} site scores per hour. Call again after ${r.time} UTC (in ${r.minutes} minutes).`;
  },
  daily_limit: "Retrofit reached today's analysis limit. Try again tomorrow.",
  unavailable: "Retrofit is having trouble. Try again in a few minutes.",
  // Not in the contract table: a 503 `unavailable` while another call's count-once decision is pending.
  counting: "Retrofit is still counting another call for this site from this client. Call again in 2 seconds with the same URL.",
  // Not in the contract table: a 503 `unavailable` while the site's daily count is undecided.
  countingSite: "Retrofit is still starting another score of this site. Call again in 2 seconds with the same URL.",
  method_not_allowed: "Use GET /api/score with the website address in the url query parameter.",
} as const;
