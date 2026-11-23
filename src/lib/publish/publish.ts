import { jsonBytes, MAX_PUBLISHED_SNAPSHOT_BYTES, MAX_REPORT_BYTES, type PublishedSite, type RefreshError } from "@/lib/accounts/data";
import { listAccountAnalyses, MAX_ACCOUNT_ANALYSES } from "@/lib/analysis/account-list";
import { ownedBy } from "@/lib/analysis/owner";
import { analysisHost, EXPIRED_GRACE_S, getAnalysis, readAnalysisView, reportBody, type Analysis } from "@/lib/analysis/record";
import { claimHost } from "@/lib/claims/host";
import type { LimitResult } from "@/lib/fetch/limits";
import { GenerationFailed, generateNetwork, type NetworkValidator } from "@/lib/generate/network";
import type { ServerDeps } from "@/lib/server/runtime";
import type { Snapshot } from "@/lib/snapshot/types";

export type PublishHostDeps = Pick<ServerDeps, "config" | "store" | "accounts" | "clock"> & {
  /** Replaces the vendored validator (tests force a failure through it). */
  readonly validate?: NetworkValidator;
};

export type PublishHostResult =
  | { readonly outcome: "published" | "refreshed"; readonly site: PublishedSite }
  | { readonly outcome: "no_claim" | "not_verified" }
  | { readonly outcome: "limited"; readonly retryAt: number }
  /**
   * The published copy is as new as the newest ready analysis; nothing changed and nothing was recorded or counted.
   * `newReadAt` (ms): until then Retrofit reuses that analysis's read, so a new analysis brings nothing newer; null when
   * a new read is already possible.
   */
  | { readonly outcome: "not_newer"; readonly site: PublishedSite | null; readonly newReadAt: number | null }
  /** The publish failed. `site`: the account's unchanged publication with this code recorded on it, or null when it had none. */
  | { readonly outcome: RefreshError; readonly site: PublishedSite | null };

/** A ready analysis: the copied snapshot, its score and the time the read was ready. */
type Ready = Analysis & { readonly snapshot: Snapshot; readonly readyAt: number };

/** Records read at once; only the best one so far is kept. */
const READ_AT_ONCE = 5;
const MINUTE_MS = 60_000;

const readOf = (a: Pick<Ready, "snapshot">) => Date.parse(a.snapshot.fetchedAt);

/**
 * The account's ready analysis with the newest read whose scored host is exactly `host`, or null. Not the
 * last started: that one may have used an older cached read of another address. The list entry names the
 * typed host until the report is first read, so each record decides.
 */
async function newestReady(deps: PublishHostDeps, accountId: string, host: string): Promise<Ready | null> {
  const now = deps.clock();
  // Past its life an analysis is only an expiry notice.
  const entries = (await listAccountAnalyses(deps, accountId, MAX_ACCOUNT_ANALYSES)).filter((e) => now < e.keptUntil - EXPIRED_GRACE_S * 1000);
  async function ready(id: string): Promise<Ready | null> {
    const analysis = await getAnalysis(deps.store, id);
    if (!analysis || !ownedBy(analysis, null, { accountId })) return null;
    const view = await readAnalysisView(deps, analysis);
    const { snapshot, score, readyAt } = view.analysis;
    if (view.status !== "ready" || !snapshot || score === undefined || readyAt === undefined) return null;
    return claimHost(analysisHost(view.analysis)) === host ? { ...view.analysis, snapshot, readyAt } : null;
  }
  let best: Ready | null = null;
  for (let i = 0; i < entries.length; i += READ_AT_ONCE) {
    for (const a of await Promise.all(entries.slice(i, i + READ_AT_ONCE).map((e) => ready(e.id)))) {
      if (a && (!best || readOf(a) > readOf(best))) best = a;
    }
  }
  return best;
}

/** When a new read of the analysis's site is possible: its crawl's cache ends (src/lib/crawl/jobs.ts), as the next whole minute. */
function newReadFrom(a: Ready, deps: PublishHostDeps): number | null {
  const at = Math.ceil((a.readyAt + deps.config.crawlCacheTtlS * 1000 + 1) / MINUTE_MS) * MINUTE_MS;
  return at > deps.clock() ? at : null;
}

/**
 * Publishes the account's newest ready analysis of `host`, or refreshes the published copy (parent
 * plan, "Publishing and the badge"). The caller has checked the account's claim; the write checks it
 * again (AccountData publishSite). `admit` counts the publish against the hourly limit; a refresh that
 * would change nothing is not counted. The network is generated and validated before anything is
 * written. A failure keeps the published copy and records its code on it. Throws when the Store or the
 * account data is unavailable.
 */
export async function publishHost(deps: PublishHostDeps, accountId: string, host: string, admit: () => Promise<LimitResult>): Promise<PublishHostResult> {
  const own = async () => (await deps.accounts.listPublishedSites(accountId)).find((s) => s.host === host) ?? null;
  async function failed(code: RefreshError): Promise<PublishHostResult> {
    return { outcome: code, site: (await deps.accounts.recordRefreshError(accountId, host, code)) ? await own() : null };
  }

  const [analysis, current] = await Promise.all([newestReady(deps, accountId, host), own()]);
  if (analysis && current && readOf(analysis) <= Date.parse(current.fetchedAt)) return { outcome: "not_newer", site: current, newReadAt: newReadFrom(analysis, deps) };
  const admitted = await admit();
  if (!admitted.ok) return { outcome: "limited", retryAt: admitted.retryAt };
  if (!analysis) return failed("no_analysis");

  const { snapshot } = analysis;
  try {
    generateNetwork({ snapshot, target: "bundle" }, { validate: deps.validate });
  } catch (e) {
    if (!(e instanceof GenerationFailed)) throw e;
    return failed("generation_failed");
  }
  const report = reportBody(analysis.score, analysis.readyAt, deps.config);
  if (jsonBytes(snapshot) > MAX_PUBLISHED_SNAPSHOT_BYTES || jsonBytes(report) > MAX_REPORT_BYTES) return failed("too_large");

  const result = await deps.accounts.publishSite(accountId, {
    host,
    snapshot: snapshot as unknown as Record<string, unknown>,
    report,
    fetchedAt: snapshot.fetchedAt,
    now: new Date(deps.clock()).toISOString(),
  });
  if ("site" in result) return result;
  // Another tab refreshed it in between.
  return result.outcome === "not_newer" ? { outcome: "not_newer", site: await own(), newReadAt: newReadFrom(analysis, deps) } : { outcome: result.outcome };
}
