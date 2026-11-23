import { jsonBytes, MAX_PUBLISHED_SNAPSHOT_BYTES, MAX_REPORT_BYTES, type PublishedSite, type PublishSiteResult, type RefreshError } from "@/lib/accounts/data";
import { listAccountAnalyses, MAX_ACCOUNT_ANALYSES } from "@/lib/analysis/account-list";
import { accountAnalysis } from "@/lib/analysis/owner";
import { analysisHost, cachedUntil, EXPIRED_GRACE_S, readAnalysisView, readyAnalysis, reportBody, type ReadyAnalysis } from "@/lib/analysis/record";
import { claimHost } from "@/lib/claims/host";
import { GenerationFailed, generateNetwork, type NetworkValidator } from "@/lib/generate/network";
import type { ServerDeps } from "@/lib/server/runtime";
import { agentSnapshot } from "@/lib/snapshot/types";

export type PublishHostDeps = Pick<ServerDeps, "config" | "store" | "accounts" | "billing" | "clock"> & {
  /** Replaces the vendored validator (tests force a failure through it). */
  readonly validate?: NetworkValidator;
};

/** The publish failed. `site`: the account's unchanged publication with the code recorded on it, or null when it had none. */
export type PublishFailure = { readonly outcome: RefreshError; readonly site: PublishedSite | null };

/** Records read at once; only the best one so far is kept. */
const READ_AT_ONCE = 5;
const MINUTE_MS = 60_000;

const readOf = (a: Pick<ReadyAnalysis, "snapshot">) => Date.parse(a.snapshot.fetchedAt);

/**
 * The account's ready analysis with the newest read whose scored host is exactly `host`, or null. Not the
 * last started: that one may have used an older cached read of another address. The list entry names the
 * typed host until the report is first read, so each record decides.
 */
async function newestReady(deps: PublishHostDeps, accountId: string, host: string): Promise<ReadyAnalysis | null> {
  const now = deps.clock();
  // Past its life an analysis is only an expiry notice.
  const entries = (await listAccountAnalyses(deps, accountId, MAX_ACCOUNT_ANALYSES)).filter((e) => now < e.keptUntil - EXPIRED_GRACE_S * 1000);
  async function ready(id: string): Promise<ReadyAnalysis | null> {
    const analysis = await accountAnalysis(deps.store, accountId, id);
    const found = analysis && readyAnalysis(await readAnalysisView(deps, analysis));
    return found && claimHost(analysisHost(found)) === host ? found : null;
  }
  let best: ReadyAnalysis | null = null;
  for (let i = 0; i < entries.length; i += READ_AT_ONCE) {
    for (const a of await Promise.all(entries.slice(i, i + READ_AT_ONCE).map((e) => ready(e.id)))) {
      if (a && (!best || readOf(a) > readOf(best))) best = a;
    }
  }
  return best;
}

/** What a publish would use: the newest ready analysis (or none) and the account's current publication of the host. */
export interface PublishSource {
  readonly analysis: ReadyAnalysis | null;
  readonly current: PublishedSite | null;
}

export async function publishSource(deps: PublishHostDeps, accountId: string, host: string): Promise<PublishSource> {
  const [analysis, sites] = await Promise.all([newestReady(deps, accountId, host), deps.accounts.listPublishedSites(accountId)]);
  return { analysis, current: sites.find((s) => s.host === host) ?? null };
}

/** True when the analysis has no newer read than the published copy: publishing it would change nothing. */
export function isPublished({ analysis, current }: PublishSource): boolean {
  return analysis !== null && current !== null && readOf(analysis) <= Date.parse(current.fetchedAt);
}

/** When a new read of the analysis's site is possible (cachedUntil, as the next whole minute); null when it is already. */
export function newReadFrom(a: Pick<ReadyAnalysis, "readyAt">, deps: Pick<PublishHostDeps, "config" | "clock">): Date | null {
  const at = Math.ceil((cachedUntil(a.readyAt, deps.config) + 1) / MINUTE_MS) * MINUTE_MS;
  return at > deps.clock() ? new Date(at) : null;
}

/**
 * Publishes the analysis as the account's site for `host`, or refreshes the published copy (parent plan,
 * "Publishing and the badge"). The caller has checked the account's claim; the write checks it again
 * (AccountData publishSite). The network is generated and validated from the stored form (agentSnapshot)
 * before anything is written. A failure keeps the published copy and records its code on it. Throws when
 * the account data is unavailable.
 */
export async function publishHost(deps: PublishHostDeps, accountId: string, host: string, analysis: ReadyAnalysis | null): Promise<PublishSiteResult | PublishFailure> {
  const failed = async (code: RefreshError): Promise<PublishFailure> => ({ outcome: code, site: await deps.accounts.recordRefreshError(accountId, host, code) });

  if (!analysis) return failed("no_analysis");
  const snapshot = agentSnapshot(analysis.snapshot);
  try {
    generateNetwork({ snapshot, target: "bundle" }, { validate: deps.validate });
  } catch (e) {
    if (!(e instanceof GenerationFailed)) throw e;
    return failed("generation_failed");
  }
  const report = reportBody(analysis.score, analysis.readyAt, deps.config);
  if (jsonBytes(snapshot) > MAX_PUBLISHED_SNAPSHOT_BYTES || jsonBytes(report) > MAX_REPORT_BYTES) return failed("too_large");
  return deps.accounts.publishSite(accountId, { host, snapshot, report, fetchedAt: snapshot.fetchedAt, now: new Date(deps.clock()).toISOString() });
}
