import type { Config } from "@/lib/config";
import { NotPublicError } from "@/lib/fetch/errors";
import { countClientAnalysis } from "@/lib/fetch/limits";
import { validateUrl } from "@/lib/fetch/url";
import type { ServerDeps } from "@/lib/server/runtime";
import { dispatchQueued, startCrawlJob, type Invocation } from "./capacity";
import { indexVisitorAnalysis } from "./owner";
import { createAnalysis } from "./record";
import { COUNTING_RETRY_S, visitorTexts } from "./texts";

/**
 * True for a request from Retrofit's own page: `Sec-Fetch-Site: same-origin`,
 * or an `Origin` header equal to PUBLIC_ORIGIN (phase-3.md `startAnalysis` pre).
 */
export function isSameOrigin(request: Request, config: Pick<Config, "publicOrigin">): boolean {
  if (request.headers.get("sec-fetch-site") === "same-origin") return true;
  return request.headers.get("origin") === config.publicOrigin;
}

const HAS_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

/** Trims, and prefixes `https://` when the value has no scheme (score contract validation rule 3). */
export function withDefaultScheme(raw: string): string {
  const v = raw.trim();
  return v === "" || HAS_SCHEME.test(v) ? v : `https://${v}`;
}

export type StartOutcome =
  | { readonly ok: true; readonly id: string }
  | { readonly ok: false; readonly status: 400 | 429; readonly code: "not_public" | "client_limit" | "daily_limit"; readonly message: string; readonly retryAt?: string }
  /** The site's daily count is undecided: nothing was started; try again after `retryAfterSeconds`. */
  | { readonly ok: false; readonly status: 503; readonly code: "counting"; readonly message: string; readonly retryAfterSeconds: number };

/**
 * Starts a visitor-owned analysis (phase-3.md `startAnalysis`). Every analysis
 * is new and owned by its visitor; only the crawl work is shared. The caller
 * checks the same-origin precondition.
 */
export async function startAnalysis(
  deps: ServerDeps,
  o: { rawUrl: string; ownerHash: string; clientId: string; invocation?: Invocation; accountId?: string },
): Promise<StartOutcome> {
  const invocation = o.invocation ?? { startedAt: deps.clock() };
  // 1. Validate the URL.
  let url: URL;
  try {
    url = validateUrl(withDefaultScheme(o.rawUrl), deps.config);
  } catch (e) {
    if (e instanceof NotPublicError) return { ok: false, status: 400, code: "not_public", message: visitorTexts.notPublic };
    throw e;
  }

  // 2. The per-client window.
  const limit = await countClientAnalysis(deps.store, deps.config, o.clientId, deps.clock());
  if (!limit.ok) {
    const retryAt = new Date(limit.retryAt);
    return { ok: false, status: 429, code: "client_limit", message: visitorTexts.clientLimit(deps.config.analysesPerClientHour, retryAt), retryAt: retryAt.toISOString() };
  }

  // 3. Start or join the shared crawl; a new job is queued for a slot.
  const crawl = await startCrawlJob(deps, url.origin);
  if (!crawl.ok && crawl.code === "counting") return { ok: false, status: 503, code: "counting", message: visitorTexts.counting, retryAfterSeconds: COUNTING_RETRY_S };
  if (!crawl.ok) return { ok: false, status: 429, code: "daily_limit", message: visitorTexts.dailyLimit, retryAt: new Date(crawl.retryAt).toISOString() };

  // 4. A new analysis owned by this visitor (and attached to the signed-in account, if any). An
  // anonymous analysis is listed under its visitor so that sign-in can attach it; a failure there
  // costs only that attachment, so it is logged and the analysis goes on.
  const analysis = await createAnalysis(deps, { ownerHash: o.ownerHash, jobId: crawl.jobId, inputOrigin: url.origin, accountId: o.accountId });
  if (!o.accountId) {
    await indexVisitorAnalysis(deps, o.ownerHash, analysis.id).catch((e: unknown) => {
      console.error("Visitor analysis list failed:", e instanceof Error ? e.name : "unknown error");
    });
  }

  // 5. Start queued work (this job, when a slot is free) through waitUntil.
  await dispatchQueued(deps, invocation);
  return { ok: true, id: analysis.id };
}
