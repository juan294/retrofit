import { jsonBytes, MAX_PUBLISHED_SNAPSHOT_BYTES, MAX_REPORT_BYTES, type PublishedSite, type RefreshError } from "@/lib/accounts/data";
import { listAccountAnalyses, MAX_ACCOUNT_ANALYSES } from "@/lib/analysis/account-list";
import { ownedBy } from "@/lib/analysis/owner";
import { analysisHost, EXPIRED_GRACE_S, getAnalysis, readAnalysisView, reportBody, type Analysis } from "@/lib/analysis/record";
import { claimHost } from "@/lib/claims/host";
import { GenerationFailed, generateNetwork, type NetworkValidator } from "@/lib/generate/network";
import type { ServerDeps } from "@/lib/server/runtime";

export type PublishHostDeps = Pick<ServerDeps, "config" | "store" | "accounts" | "clock"> & {
  /** Replaces the vendored validator (tests force a failure through it). */
  readonly validate?: NetworkValidator;
};

export type PublishHostResult =
  | { readonly outcome: "published" | "refreshed"; readonly site: PublishedSite }
  | { readonly outcome: "no_claim" | "not_verified" }
  /** Nothing changed. `site`: the account's publication with this code recorded on it, or null when it had none. */
  | { readonly outcome: RefreshError; readonly site: PublishedSite | null };

/**
 * The newest ready analysis attached to the account whose scored host is exactly `host`, or null. The
 * list entry names the typed host until the report is first read, so each record decides. Newest
 * started first; the records are read one by one and the search stops at the first match.
 */
async function newestReady(deps: PublishHostDeps, accountId: string, host: string): Promise<Analysis | null> {
  const now = deps.clock();
  const entries = (await listAccountAnalyses(deps, accountId, MAX_ACCOUNT_ANALYSES))
    // Past its life an analysis is only an expiry notice.
    .filter((e) => now < e.keptUntil - EXPIRED_GRACE_S * 1000)
    .sort((x, y) => y.keptUntil - x.keptUntil);
  for (const { id } of entries) {
    const analysis = await getAnalysis(deps.store, id);
    if (!analysis || !ownedBy(analysis, null, { accountId })) continue;
    const view = await readAnalysisView(deps, analysis);
    const a = view.analysis;
    if (view.status === "ready" && a.snapshot && a.score !== undefined && a.readyAt !== undefined && claimHost(analysisHost(a)) === host) return a;
  }
  return null;
}

/**
 * Publishes the account's newest ready analysis of `host`, or refreshes the published copy (parent
 * plan, "Publishing and the badge"). The caller has checked the account's claim; the write checks it
 * again (AccountData publishSite). The network is generated and validated before anything is written.
 * A failure keeps the published copy and records its code on it. Throws when the Store or the account
 * data is unavailable.
 */
export async function publishHost(deps: PublishHostDeps, accountId: string, host: string): Promise<PublishHostResult> {
  async function failed(code: RefreshError): Promise<PublishHostResult> {
    const recorded = await deps.accounts.recordRefreshError(accountId, host, code);
    const site = recorded ? (await deps.accounts.listPublishedSites(accountId)).find((s) => s.host === host) : undefined;
    return { outcome: code, site: site ?? null };
  }

  const analysis = await newestReady(deps, accountId, host);
  if (!analysis?.snapshot) return failed("no_analysis");
  const { snapshot } = analysis;
  try {
    generateNetwork({ snapshot, target: "bundle" }, { validate: deps.validate });
  } catch (e) {
    if (!(e instanceof GenerationFailed)) throw e;
    return failed("generation_failed");
  }
  const report = reportBody(analysis.score, analysis.readyAt!, deps.config);
  if (jsonBytes(snapshot) > MAX_PUBLISHED_SNAPSHOT_BYTES || jsonBytes(report) > MAX_REPORT_BYTES) return failed("too_large");

  const result = await deps.accounts.publishSite(accountId, {
    host,
    snapshot: snapshot as unknown as Record<string, unknown>,
    report,
    fetchedAt: snapshot.fetchedAt,
    now: new Date(deps.clock()).toISOString(),
  });
  if ("site" in result) return result;
  return result.outcome === "not_newer" ? failed("not_newer") : { outcome: result.outcome };
}
