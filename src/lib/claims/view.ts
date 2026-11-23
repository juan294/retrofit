import type { Claim, ClaimMethod, ClaimStatus } from "@/lib/accounts/data";
import type { Config } from "@/lib/config";
import { CLAIMS_TEXT as T } from "@/lib/site/claims-texts";
import { claimPageUrl, claimRecordName } from "./host";

/**
 * A claim as the account page and the claim API show it: never the token or its hash. The token
 * itself appears only in the create and Start over answers, once.
 */
export interface ClaimView {
  readonly id: string;
  readonly host: string;
  readonly method: ClaimMethod;
  readonly status: ClaimStatus;
  readonly statusText: string;
  /** The home page a meta check reads. */
  readonly url: string;
  /** The TXT record a DNS check reads. */
  readonly recordName: string;
  /** Where Retrofit looks, for the claim's method. */
  readonly where: string;
  /** What the latest check read and found, or null before the first check. */
  readonly reason: string | null;
  readonly lastChecked: string;
  /** Check again: every state but superseded. */
  readonly canCheck: boolean;
  /** Start over (and switching the method): pending and lapsed claims. */
  readonly canStartOver: boolean;
}

/** The home page URL of a host, also when it is not a public website (for the text only). */
function pageUrl(host: string, config: Pick<Config, "fixturesEnabled">): string {
  try {
    return claimPageUrl(host, config).href;
  } catch {
    return `https://${host}/`;
  }
}

export function claimView(claim: Claim, config: Pick<Config, "fixturesEnabled">): ClaimView {
  const url = pageUrl(claim.host, config);
  const recordName = claimRecordName(claim.host);
  const statusText =
    claim.status === "verified"
      ? T.status.verified(claim.verifiedAt ?? claim.createdAt)
      : claim.status === "lapsed"
        ? T.status.lapsed(claim.lapsedAt ?? claim.lastCheckedAt ?? claim.createdAt)
        : claim.status === "superseded"
          ? T.status.superseded(claim.supersededAt ?? claim.createdAt)
          : T.status.pending;
  return {
    id: claim.id,
    host: claim.host,
    method: claim.method,
    status: claim.status,
    statusText,
    url,
    recordName,
    where: claim.method === "meta" ? T.pendingMeta(url) : T.pendingDns(recordName),
    reason: claim.lastResult === null ? null : T.reason(claim.lastResult, claim.method, { host: claim.host, url, recordName }, claim.lastDetail),
    lastChecked: claim.lastCheckedAt === null ? T.neverChecked : T.lastChecked(claim.lastCheckedAt),
    canCheck: claim.status !== "superseded",
    canStartOver: claim.status === "pending" || claim.status === "lapsed",
  };
}
