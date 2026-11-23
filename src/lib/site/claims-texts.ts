// Copy for ownership claims on /account and in the claim API answers, in one module so a UI pass can
// restyle the claim panels without touching their logic. Every text names what Retrofit checked (the
// URL or the record name) and what it found; it never quotes the site's own content.

import { CLAIM_CHECKS_PER_HOUR, MAX_PENDING_CLAIMS } from "@/lib/accounts/limits";
import type { ClaimMethod, ClaimResult, ClaimStatus } from "@/lib/accounts/data";
import { formatDate, hhmmUtc } from "@/lib/analysis/texts";
import { CLAIM_META_NAME, CLAIM_TXT_PREFIX } from "@/lib/claims/names";
import { LEAD_EMAIL } from "./own-site";

/** What a check reads: the home page URL (meta) or the record name (DNS), and the claimed host. */
export interface CheckTarget {
  readonly host: string;
  readonly url: string;
  readonly recordName: string;
}

const date = (iso: string) => formatDate(Date.parse(iso));
const at = (iso: string) => `${formatDate(Date.parse(iso))} at ${hhmmUtc(new Date(iso))} UTC`;

export const CLAIMS_TEXT = {
  heading: "Your sites",
  intro: "Claim a site you own to publish its agent on Retrofit and show the badge. Retrofit checks for a tag on the home page or a DNS record.",
  noSources: "Analyze your site first, or save one of its reports. Then you can claim it here.",
  noClaims: "No claimed sites yet.",
  sourceLabel: "Site",
  sourceFromReport: (host: string) => `${host} (saved report)`,
  sourceFromAnalysis: (host: string) => `${host} (recent analysis)`,
  methodLegend: "How to prove you own it",
  methodMeta: "A tag on the home page",
  methodDns: "A DNS record",
  claimButton: "Claim this site",
  busy: "Working…",
  checkAgain: "Check again",
  startOver: "Start over",
  useDns: "Use DNS instead",
  useMeta: "Use the tag instead",
  remove: "Remove",

  /** The record to add, with the token: shown once, right after a claim or Start over. */
  addTag: (url: string) => `Add this tag inside the <head> of ${url}, then choose Check again:`,
  addRecord: (recordName: string) => `Add a TXT record named ${recordName} with this value, then choose Check again:`,
  metaTag: (token: string) => `<meta name="${CLAIM_META_NAME}" content="${token}">`,
  txtValue: (token: string) => `${CLAIM_TXT_PREFIX}${token}`,
  tokenOnce: "Copy it now. Retrofit shows it only once. If you lose it, choose Start over for a new one.",
  /** Afterwards: only where it goes, never the token. */
  pendingMeta: (url: string) => `Retrofit looks for a ${CLAIM_META_NAME} tag in the <head> of ${url}.`,
  pendingDns: (recordName: string) => `Retrofit looks for a TXT record named ${recordName}.`,

  status: {
    pending: "Waiting for verification",
    verified: (verifiedAt: string) => `Verified on ${date(verifiedAt)}`,
    lapsed: (checkedAt: string) => `Verification failed on ${date(checkedAt)}. Your published page and badge are paused.`,
    superseded: (movedAt: string) => `Ownership moved to another account on ${date(movedAt)}.`,
  } satisfies Record<ClaimStatus, unknown>,
  lastChecked: (iso: string) => `Last checked ${at(iso)}.`,
  neverChecked: "Not checked yet.",

  reason(result: ClaimResult, method: ClaimMethod, t: CheckTarget, detail: number | null): string {
    switch (result) {
      case "verified":
        return method === "meta" ? `Retrofit found the tag on ${t.url}.` : `Retrofit found the record at ${t.recordName}.`;
      case "tag_missing":
        return `Retrofit read ${t.url} and found no ${CLAIM_META_NAME} tag in its <head>.`;
      case "tag_mismatch":
        return detail !== null && detail > 1
          ? `Retrofit read ${t.url} and found ${detail} ${CLAIM_META_NAME} tags, but none has this claim's token.`
          : `Retrofit read ${t.url} and found a ${CLAIM_META_NAME} tag, but it does not have this claim's token.`;
      case "robots_blocked":
        return "Your robots.txt blocks RetrofitBot, so Retrofit cannot read the tag. Use the DNS method instead.";
      case "robots_unavailable":
        return `Retrofit could not read the robots rules of ${t.host}, so it did not read ${t.url}. Check again later, or use the DNS method.`;
      case "redirected":
        return `${t.url} redirects to another host. Add the tag to the home page of ${t.host} itself, or use the DNS method.`;
      case "http_status":
        return `Retrofit read ${t.url} and got HTTP status ${detail ?? "an error"}.`;
      case "not_html":
        return `Retrofit read ${t.url}, but it is not an HTML page.`;
      case "timeout":
        return `Retrofit could not read ${t.url} in time. Check again in a few minutes.`;
      case "not_public":
        return `${t.host} is not a public website address that Retrofit can read.`;
      case "fetch_failed":
        return `Retrofit could not read ${t.url}. Check again in a few minutes.`;
      case "record_missing":
        return `Retrofit found no TXT record at ${t.recordName}. New DNS records can take time to appear, sometimes hours. Check again later.`;
      case "record_mismatch":
        return detail === 1
          ? `Retrofit found 1 TXT record at ${t.recordName}, but it is not ${CLAIM_TXT_PREFIX} with this claim's token.`
          : `Retrofit found ${detail ?? "several"} TXT records at ${t.recordName}, but none is ${CLAIM_TXT_PREFIX} with this claim's token.`;
      case "dns_failed":
        return `Retrofit could not look up ${t.recordName}. Check again in a few minutes.`;
    }
  },

  created: "Claim started. Add the record below, then choose Check again.",
  restarted: "New token ready. Add the record below, then choose Check again.",
  removed: "Claim removed.",
  /** A check that could not start before the deadline: nothing was recorded. */
  notChecked: "Retrofit could not check this site right now. Check again in a few minutes.",
  limit: (retryAt: Date) => `You can check a claim ${CLAIM_CHECKS_PER_HOUR} times an hour. Try again at ${hhmmUtc(retryAt)} UTC.`,
  full: `You can have at most ${MAX_PENDING_CLAIMS} claims waiting for verification. Remove one, or finish one, first.`,
  exists: "You already have a claim for this site.",
  verifiedNoRestart: "This claim is verified. Remove it first if you want to start over.",
  supersededFinal: "Another account verified this site later. Remove this claim if you want to claim the site again.",
  invalid: "Choose a site and a method.",
  notFound: "Retrofit could not find this claim or site in your account.",
  notPublic: "This site is not a public website address that Retrofit can read.",
  signedOut: "Sign in again to manage your claims.",
  tooLarge: "This request is too large.",
  unavailable: `Retrofit could not update your claims right now. Try again in a few minutes, or email ${LEAD_EMAIL}.`,
  crossOrigin: "Open Retrofit at its own address to manage your claims.",
} as const;
