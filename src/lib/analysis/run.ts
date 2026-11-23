import { billingStarted } from "@/lib/billing/entitlements";
import { reserveFreeAnalysis, type FreeCount } from "@/lib/billing/free-limit";
import type { Config } from "@/lib/config";
import { NotPublicError } from "@/lib/fetch/errors";
import { countAccountAnalysis, countClientAnalysis } from "@/lib/fetch/limits";
import { validateUrl } from "@/lib/fetch/url";
import type { ServerDeps } from "@/lib/server/runtime";
import { dispatchQueued, startCrawlJob, type Invocation } from "./capacity";
import { indexAccountAnalyses, indexVisitorAnalysis } from "./owner";
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
  | { readonly ok: false; readonly status: 400 | 403 | 429; readonly code: "not_public" | "client_limit" | "daily_limit" | "free_limit"; readonly message: string; readonly retryAt?: string }
  /** The site's daily count is undecided: nothing was started; try again after `retryAfterSeconds`. */
  | { readonly ok: false; readonly status: 503; readonly code: "counting"; readonly message: string; readonly retryAfterSeconds: number };

/**
 * Starts a visitor-owned analysis (phase-3.md `startAnalysis`). Every analysis
 * is new and owned by its visitor; only the crawl work is shared. The caller
 * checks the same-origin precondition. `free`: the visitor's free-analysis count
 * (free-limit.ts), from BILLING_START on and without an account; its place is
 * given back when the analysis does not start.
 */
export async function startAnalysis(
  deps: ServerDeps,
  o: { rawUrl: string; ownerHash: string; clientId: string; invocation?: Invocation; accountId?: string; free?: FreeCount | null },
): Promise<StartOutcome> {
  // 1. Validate the URL.
  let url: URL;
  try {
    url = validateUrl(withDefaultScheme(o.rawUrl), deps.config);
  } catch (e) {
    if (e instanceof NotPublicError) return { ok: false, status: 400, code: "not_public", message: visitorTexts.notPublic };
    throw e;
  }

  // 2. The per-client window, and from BILLING_START on a signed-in account's own.
  const limits = [countClientAnalysis(deps.store, deps.config, o.clientId, deps.clock())];
  if (o.accountId && billingStarted(deps)) limits.push(countAccountAnalysis(deps.store, deps.config, o.accountId, deps.clock()));
  for (const limit of await Promise.all(limits)) {
    if (limit.ok) continue;
    const retryAt = new Date(limit.retryAt);
    return { ok: false, status: 429, code: "client_limit", message: visitorTexts.clientLimit(deps.config.analysesPerClientHour, retryAt), retryAt: retryAt.toISOString() };
  }

  // 3. A place in the visitor's free count, given back when nothing starts.
  if (!o.free) return startCounted(deps, url, o);
  const place = await reserveFreeAnalysis(deps, o.free);
  if (!place) return { ok: false, status: 403, code: "free_limit", message: visitorTexts.freeLimit };
  try {
    const outcome = await startCounted(deps, url, o);
    if (!outcome.ok) await place.release();
    return outcome;
  } catch (e) {
    await place.release();
    throw e;
  }
}

/** The start itself, after every per-visitor limit admitted it. */
async function startCounted(deps: ServerDeps, url: URL, o: { ownerHash: string; invocation?: Invocation; accountId?: string }): Promise<StartOutcome> {
  const invocation = o.invocation ?? { startedAt: deps.clock() };
  // 4. Start or join the shared crawl; a new job is queued for a slot.
  const crawl = await startCrawlJob(deps, url.origin);
  if (!crawl.ok && crawl.code === "counting") return { ok: false, status: 503, code: "counting", message: visitorTexts.counting, retryAfterSeconds: COUNTING_RETRY_S };
  if (!crawl.ok) return { ok: false, status: 429, code: "daily_limit", message: visitorTexts.dailyLimit, retryAt: new Date(crawl.retryAt).toISOString() };

  // 5. A new analysis owned by this visitor (and attached to the signed-in account, if any). An
  // anonymous analysis is listed under its visitor so that sign-in can attach it, and an attached
  // one under its account (the account page offers it for a claim); a failure there costs only
  // that list, so it is logged and the analysis goes on.
  const analysis = await createAnalysis(deps, { ownerHash: o.ownerHash, jobId: crawl.jobId, inputOrigin: url.origin, accountId: o.accountId });
  const listed = (o.accountId ? indexAccountAnalyses(deps, o.accountId, [analysis]) : indexVisitorAnalysis(deps, o.ownerHash, analysis.id)).catch((e: unknown) => {
    console.error(`${o.accountId ? "Account" : "Visitor"} analysis list failed:`, e instanceof Error ? e.name : "unknown error");
  });

  // 6. Start queued work (this job, when a slot is free) through waitUntil, beside the list write.
  await Promise.all([listed, dispatchQueued(deps, invocation)]);
  return { ok: true, id: analysis.id };
}
