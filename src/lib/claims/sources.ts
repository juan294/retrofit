import type { Claim, SavedReportSummary } from "@/lib/accounts/data";
import { isUuid } from "@/lib/accounts/data";
import type { AccountAnalysis } from "@/lib/analysis/account-list";
import { accountAnalysis } from "@/lib/analysis/owner";
import { analysisHost, isAnalysisId } from "@/lib/analysis/record";
import type { ServerDeps } from "@/lib/server/runtime";
import { CLAIMS_TEXT } from "@/lib/site/claims-texts";
import { claimHost } from "./host";

/**
 * Where a claim's host comes from (pinned decision: never a typed host). `report:<id>` is one of the
 * account's saved reports; `analysis:<id>` is an analysis attached to the account. The host is the
 * one that analysis or report scored.
 */
export type ClaimSource = { readonly kind: "report" | "analysis"; readonly id: string };

/** Recent analyses the account page offers. */
export const CLAIM_RECENT_ANALYSES = 10;

export function parseClaimSource(raw: unknown): ClaimSource | null {
  if (typeof raw !== "string") return null;
  const colon = raw.indexOf(":");
  const kind = raw.slice(0, colon);
  const id = raw.slice(colon + 1);
  if (kind === "report" && isUuid(id)) return { kind, id };
  if (kind === "analysis" && isAnalysisId(id)) return { kind, id };
  return null;
}

/** The claim host of a source the account owns, or null (another account's, unknown, or not a host). */
export async function hostOfSource(deps: Pick<ServerDeps, "store" | "accounts">, accountId: string, source: ClaimSource): Promise<string | null> {
  if (source.kind === "report") {
    const host = await deps.accounts.getSavedReportHost(accountId, source.id);
    return host === null ? null : claimHost(host);
  }
  const analysis = await accountAnalysis(deps.store, accountId, source.id);
  return analysis && claimHost(analysisHost(analysis));
}

export interface ClaimOption {
  /** The source value the create form posts. */
  readonly value: string;
  readonly label: string;
}

/**
 * The account page's "Claim a site" choices: hosts of the recent attached analyses (listAccountAnalyses,
 * newest first), then of saved reports, once each, without the hosts the account already claims.
 */
export function claimOptions(analyses: readonly AccountAnalysis[], reports: readonly SavedReportSummary[], claims: readonly Claim[]): ClaimOption[] {
  const taken = new Set(claims.map((c) => c.host));
  const options: ClaimOption[] = [];
  const add = (host: string | null, value: string, label: (h: string) => string) => {
    if (host === null || taken.has(host)) return;
    taken.add(host);
    options.push({ value, label: label(host) });
  };
  for (const a of analyses) add(claimHost(a.host), `analysis:${a.id}`, CLAIMS_TEXT.sourceFromAnalysis);
  for (const r of reports) add(claimHost(r.host), `report:${r.id}`, CLAIMS_TEXT.sourceFromReport);
  return options;
}
