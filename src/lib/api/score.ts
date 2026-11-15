import { dispatchQueued, startCrawlJob } from "@/lib/analysis/capacity";
import { reportBody } from "@/lib/analysis/record";
import { withDefaultScheme } from "@/lib/analysis/run";
import { agentTexts, type AgentErrorCode } from "@/lib/analysis/texts";
import { VISITOR_COOKIE } from "@/lib/analysis/visitor";
import { isQueueExpired, readJobMarkingStale, type CrawlJob } from "@/lib/crawl/jobs";
import { NotPublicError } from "@/lib/fetch/errors";
import { clientIdFromRequest, countClientOrigin, nextUtcMidnight } from "@/lib/fetch/limits";
import { validateUrl } from "@/lib/fetch/url";
import type { ServerDeps } from "@/lib/server/runtime";

/**
 * GET /api/score?url= (docs/research/score-tool-contract.md, Surface 1). Open to
 * agents: CORS `*`, no cookie is read or set, no analysis id or preview path is
 * ever returned. Validation rules 1 to 10 of the contract run in order.
 */

export const MAX_REPORT_BYTES = 16 * 1024;
const POLL_MS = 250;
const RUNNING_RETRY_S = 20;
const BUSY_RETRY_S = 120;
/** Retry after an undecided client count (agentTexts.counting says 2 seconds). */
const COUNTING_RETRY_S = 2;

const HTTP: Record<AgentErrorCode, number> = {
  missing_url: 400,
  invalid_url: 400,
  not_public: 400,
  robots_blocked: 422,
  robots_unavailable: 503,
  crawl_error: 502,
  stale: 503,
  queue_expired: 503,
  client_limit: 429,
  daily_limit: 429,
  unavailable: 503,
  method_not_allowed: 405,
};

function headers(retryAfterSeconds?: number): Headers {
  const h = new Headers({ "content-type": "application/json", "access-control-allow-origin": "*", "cache-control": "no-store" });
  if (retryAfterSeconds !== undefined) h.set("retry-after", String(retryAfterSeconds));
  return h;
}

function json(status: number, body: Record<string, unknown>): Response {
  const retry = typeof body.retryAfterSeconds === "number" ? body.retryAfterSeconds : undefined;
  return new Response(JSON.stringify(body), { status, headers: headers(retry) });
}

function error(code: AgentErrorCode, message: string, o: { retryAfterSeconds?: number; retryAt?: Date } = {}): Response {
  return json(HTTP[code], {
    status: "error",
    error: code,
    message,
    ...(o.retryAfterSeconds !== undefined ? { retryAfterSeconds: o.retryAfterSeconds } : {}),
    ...(o.retryAt ? { retryAt: o.retryAt.toISOString() } : {}),
  });
}

const fixed = (code: "missing_url" | "invalid_url" | "not_public" | "robots_blocked" | "crawl_error" | "method_not_allowed") => error(code, agentTexts[code]);
const unavailable = () => error("unavailable", agentTexts.unavailable, { retryAfterSeconds: BUSY_RETRY_S });
const secondsUntil = (at: number, now: number) => Math.max(0, Math.ceil((at - now) / 1000));

/** Validation rule 4: NotPublicError.reason (free text, url.ts) to the contract's error code. */
export function codeForNotPublicReason(reason: string): "missing_url" | "invalid_url" | "not_public" {
  switch (reason) {
    case "empty":
      return "missing_url";
    case "too long":
    case "not a URL":
    case "scheme":
    case "credentials":
      return "invalid_url";
    default:
      // "port", "IP literal", "no public suffix", and the guard's resolution reasons.
      return "not_public";
  }
}

/** OPTIONS /api/score. */
export function handleScoreOptions(): Response {
  const h = headers();
  h.set("access-control-allow-methods", "GET");
  return new Response(null, { status: 204, headers: h });
}

/** Any method other than GET and OPTIONS. */
export function handleScoreMethodNotAllowed(): Response {
  return fixed("method_not_allowed");
}

export async function handleScore(request: Request, deps: ServerDeps): Promise<Response> {
  const invocation = { startedAt: deps.clock() };
  // Every request dispatches queued work, including the early returns below.
  deps.waitUntil(dispatchQueued(deps, invocation));

  // Rule 1: method.
  if (request.method === "OPTIONS") return handleScoreOptions();
  if (request.method !== "GET") return handleScoreMethodNotAllowed();

  // Rule 2: exactly one url.
  const values = new URL(request.url).searchParams.getAll("url");
  if (values.length > 1) return fixed("invalid_url");
  const raw = values[0] ?? "";
  if (raw.trim() === "") return fixed("missing_url");

  // Rules 3 to 5: https:// prefix, validateUrl, origin as the job key.
  let origin: string;
  try {
    origin = validateUrl(withDefaultScheme(raw), deps.config).origin;
  } catch (e) {
    if (e instanceof NotPublicError) return fixed(codeForNotPublicReason(e.reason));
    return unavailable();
  }

  try {
    // Rule 6: client limit, each origin counted once per client per window.
    const now = deps.clock();
    const limit = await countClientOrigin(deps.store, deps.config, clientIdFromRequest(request, deps.config, now), origin, now);
    // Another call for this origin by this client is still being counted: retry in a moment.
    if (!limit.ok && "undecided" in limit) return error("unavailable", agentTexts.counting, { retryAfterSeconds: COUNTING_RETRY_S });
    if (!limit.ok) {
      const retryAfterSeconds = secondsUntil(limit.retryAt, now);
      const retryAt = new Date(limit.retryAt);
      return error("client_limit", agentTexts.client_limit(deps.config.analysesPerClientHour, retryAfterSeconds, retryAt), { retryAfterSeconds, retryAt });
    }

    // Rule 7: start or join, capacity and daily cap, then dispatch.
    const crawl = await startCrawlJob(deps, origin);
    if (!crawl.ok) {
      return error("daily_limit", agentTexts.daily_limit, { retryAfterSeconds: secondsUntil(crawl.retryAt, deps.clock()), retryAt: new Date(crawl.retryAt) });
    }
    await dispatchQueued(deps, invocation);

    // Rules 8 and 9: wait for a final state, then map it.
    const job = await waitForJob(deps, crawl.jobId);
    return respondFor(job, deps);
  } catch (e) {
    console.error("GET /api/score failed:", e instanceof Error ? e.message : String(e));
    return unavailable();
  }
}

function running(job: CrawlJob, deps: ServerDeps): boolean {
  return (job.status === "queued" && !isQueueExpired(job, deps.config, deps.clock())) || job.status === "crawling";
}

async function waitForJob(deps: ServerDeps, jobId: string): Promise<CrawlJob | null> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = deps.clock() + deps.config.scoreWaitMs;
  let job = await readJobMarkingStale(deps, jobId);
  while (job && running(job, deps) && deps.clock() < deadline) {
    await sleep(Math.max(1, Math.min(POLL_MS, deadline - deps.clock())));
    job = await readJobMarkingStale(deps, jobId);
  }
  return job;
}

function respondFor(job: CrawlJob | null, deps: ServerDeps): Response {
  if (!job) return unavailable();
  const now = deps.clock();
  switch (job.status) {
    case "ready":
      return readyReport(job, deps);
    case "queued":
      if (isQueueExpired(job, deps.config, now)) return error("queue_expired", agentTexts.queue_expired, { retryAfterSeconds: BUSY_RETRY_S });
    // falls through: a live queued job answers like a crawling one.
    case "crawling":
      return json(202, { status: "running", retryAfterSeconds: RUNNING_RETRY_S, message: agentTexts.running });
    case "failed":
      return failureResponse(job, now);
    default:
      return unavailable();
  }
}

function failureResponse(job: CrawlJob, now: number): Response {
  const code = job.failure?.code;
  switch (code) {
    case "robots_blocked":
    case "not_public":
    case "crawl_error":
      return fixed(code);
    case "stale":
      return error("stale", agentTexts.stale, { retryAfterSeconds: 0 });
    case "daily_limit": {
      // A job that another request failed at the daily cap.
      const midnight = nextUtcMidnight(now);
      return error("daily_limit", agentTexts.daily_limit, { retryAfterSeconds: secondsUntil(midnight, now), retryAt: new Date(midnight) });
    }
    case "robots_unavailable": {
      const at = job.failure?.retryAt ? Date.parse(job.failure.retryAt) : Number.NaN;
      if (Number.isNaN(at)) return unavailable();
      const retryAfterSeconds = secondsUntil(at, now);
      const retryAt = new Date(at);
      return error("robots_unavailable", agentTexts.robots_unavailable(retryAfterSeconds, retryAt), { retryAfterSeconds, retryAt });
    }
    default:
      return unavailable();
  }
}

/** Rule 10: the report is at most 16 KB and names no analysis, preview path or cookie. */
function readyReport(job: CrawlJob, deps: ServerDeps): Response {
  if (typeof job.score !== "object" || job.score === null) return unavailable();
  const text = JSON.stringify(reportBody(job.score, job.updatedAt, deps.config));
  const origin = deps.config.publicOrigin;
  const leaks = [`${origin}/r/`, `${origin}/p/`, `"analysisId"`, VISITOR_COOKIE];
  if (Buffer.byteLength(text) > MAX_REPORT_BYTES || leaks.some((s) => text.includes(s))) {
    console.error("GET /api/score refused a report that failed the size or leak check.");
    return unavailable();
  }
  return new Response(text, { status: 200, headers: headers() });
}
