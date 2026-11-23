import * as cheerio from "cheerio";
import { sameHash } from "@/lib/analysis/visitor";
import type { Claim, ClaimResult } from "@/lib/accounts/data";
import { CrawlDelayTooLong, FetchTimeoutError, NotPublicError, RobotsBlocked, RobotsUnavailable } from "@/lib/fetch/errors";
import { guardedFetch } from "@/lib/fetch/http";
import { sha256Hex } from "@/lib/security/tokens";
import type { ServerDeps } from "@/lib/server/runtime";
import { beforeDeadline, TIMED_OUT } from "@/lib/fetch/timers";
import { claimHostname, claimPageUrl, claimRecordName } from "./host";
import { CLAIM_META_NAME, CLAIM_TXT_PREFIX } from "./names";
import { isNoRecord } from "./txt";

/**
 * verifyClaim (phase-3.md): one check of an ownership claim, and its record.
 *
 * Meta: the home page is read with guardedFetch (robots rules, pacing per host, the address guard,
 * the size and time limits); only `<head>` is parsed, and only `<meta name="retrofit-site-verification">`
 * (name matched without case) counts. A redirect to another host does not count: the tag must be
 * on the claimed host. DNS: the TXT records of `_retrofit-verification.<host name>`, each record's
 * strings joined; a record must equal `retrofit-site-verification=<token>` exactly.
 *
 * The page and the records are untrusted data: a check returns only a result code and a number,
 * never their text. A value matches when its SHA-256 equals the stored hash (constant time).
 */

/** `deferred`: no request could start before the caller's deadline (a long crawl delay); nothing was checked. */
export type CheckOutcome =
  | { readonly passed: true }
  | { readonly passed: false; readonly result: Exclude<ClaimResult, "verified">; readonly detail: number | null }
  | { readonly passed: null; readonly deferred: true };

/**
 * How long a check may take. `notAfter` (ms, deps.clock): no request starts later, and a TXT lookup
 * still waiting then is given up. `maxWaitMs`: the longest wait the caller ever allows; a site whose
 * Crawl-delay is longer can never be read, so the check fails with crawl_delay instead of waiting
 * (otherwise a recheck would be deferred forever). `onTimeout`: a TXT lookup given up at `notAfter`
 * is recorded as dns_timeout (`record`, a visitor's check) or deferred (`defer`, the daily run, whose
 * budget is then spent).
 */
export interface CheckDeadline {
  readonly notAfter: number;
  readonly maxWaitMs: number;
  readonly onTimeout: "record" | "defer";
}

export type ClaimCheckDeps = Pick<ServerDeps, "config" | "fetch" | "txt" | "clock" | "sleep">;

/** HTML's ASCII whitespace (the spec's "strip leading and trailing ASCII whitespace"). */
const ASCII_SPACE = /^[\t\n\f\r ]+|[\t\n\f\r ]+$/g;

const fail = (result: Exclude<ClaimResult, "verified">, detail: number | null = null): CheckOutcome => ({ passed: false, result, detail });

/** True when one of `values` is the claim's token. Every value is compared, so the time does not tell which one matched. */
function anyMatches(values: readonly string[], tokenHash: string): boolean {
  let found = false;
  for (const v of values) found = sameHash(sha256Hex(v), tokenHash) || found;
  return found;
}

async function checkMeta(deps: ClaimCheckDeps, claim: Pick<Claim, "host" | "tokenHash">, deadline: CheckDeadline | undefined): Promise<CheckOutcome> {
  let url: URL;
  try {
    url = claimPageUrl(claim.host, deps.config);
  } catch {
    return fail("not_public");
  }
  let res;
  try {
    res = await guardedFetch(url, deps.fetch, { notAfter: deadline?.notAfter });
  } catch (e) {
    if (e instanceof CrawlDelayTooLong) return deadline && e.intervalMs > deadline.maxWaitMs ? fail("crawl_delay", Math.round(e.intervalMs / 1000)) : { passed: null, deferred: true };
    if (e instanceof RobotsBlocked) return fail("robots_blocked");
    if (e instanceof RobotsUnavailable) return fail("robots_unavailable");
    if (e instanceof FetchTimeoutError) return fail("timeout");
    if (e instanceof NotPublicError) return fail("not_public");
    return fail("fetch_failed");
  }
  if (new URL(res.url).host !== url.host) return fail("redirected");
  if (res.status < 200 || res.status > 299) return fail("http_status", res.status);
  const type = (res.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase();
  if (res.body === null || (type !== "text/html" && type !== "application/xhtml+xml")) return fail("not_html");

  const $ = cheerio.load(res.body);
  const values = $("head meta[name]")
    .filter((_, el) => ($(el).attr("name") ?? "").trim().toLowerCase() === CLAIM_META_NAME)
    .map((_, el) => ($(el).attr("content") ?? "").replace(ASCII_SPACE, ""))
    .get();
  if (values.length === 0) return fail("tag_missing");
  return anyMatches(values, claim.tokenHash) ? { passed: true } : fail("tag_mismatch", values.length);
}

async function checkDns(deps: ClaimCheckDeps, claim: Pick<Claim, "host" | "tokenHash">, deadline: CheckDeadline | undefined): Promise<CheckOutcome> {
  let records: string[][];
  try {
    const lookup = deps.txt(claimRecordName(claim.host));
    const answer = deadline ? await beforeDeadline(lookup, Math.max(0, deadline.notAfter - deps.clock()), deps.sleep) : await lookup;
    if (answer === TIMED_OUT) return deadline?.onTimeout === "record" ? fail("dns_timeout") : { passed: null, deferred: true };
    records = answer;
  } catch (e) {
    return fail(isNoRecord(e) ? "record_missing" : "dns_failed");
  }
  const values = records.map((chunks) => chunks.join(""));
  if (values.length === 0) return fail("record_missing");
  const tokens = values.filter((v) => v.startsWith(CLAIM_TXT_PREFIX)).map((v) => v.slice(CLAIM_TXT_PREFIX.length));
  return anyMatches(tokens, claim.tokenHash) ? { passed: true } : fail("record_mismatch", values.length);
}

/** One check of the claim's current token by its method. Never throws for a site or DNS failure. */
export async function checkClaim(deps: ClaimCheckDeps, claim: Pick<Claim, "host" | "method" | "tokenHash">, deadline?: CheckDeadline): Promise<CheckOutcome> {
  try {
    claimHostname(claim.host);
  } catch {
    return fail("not_public");
  }
  return claim.method === "meta" ? checkMeta(deps, claim, deadline) : checkDns(deps, claim, deadline);
}

/**
 * Checks the claim and records the result (AccountData verifyClaim or recordClaimFailure), with
 * the time from deps.clock. Returns the claim as stored afterwards, and `checked: false` when
 * nothing was recorded: the claim is superseded, Start over replaced its token during the check,
 * or the check was deferred. A verification by another account moves the host and ends the old
 * account's publication (verifyClaim); a lapse hides this account's (AccountData getPublicSite reads
 * the claim's state), so no published page needs a write here.
 * Throws when the account data is unavailable.
 */
export async function runClaimCheck(deps: ClaimCheckDeps & Pick<ServerDeps, "accounts">, claim: Claim, deadline?: CheckDeadline): Promise<{ claim: Claim; checked: boolean }> {
  if (claim.status === "superseded") return { claim, checked: false };
  const outcome = await checkClaim(deps, claim, deadline);
  if (outcome.passed === null) return { claim, checked: false };
  const checkedAt = new Date(deps.clock()).toISOString();
  const recorded = outcome.passed
    ? await deps.accounts.verifyClaim(claim.id, { tokenHash: claim.tokenHash, checkedAt })
    : await deps.accounts.recordClaimFailure(claim.id, { tokenHash: claim.tokenHash, result: outcome.result, detail: outcome.detail, checkedAt });
  if (recorded.outcome === "missing") return { claim, checked: false };
  return { claim: recorded.claim, checked: recorded.outcome === "verified" || recorded.outcome === "updated" };
}
