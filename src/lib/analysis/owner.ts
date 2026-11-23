import { readAccountByToken, readAccountToken, type Account } from "@/lib/accounts/session";
import type { Config } from "@/lib/config";
import { sha256Hex } from "@/lib/security/tokens";
import { appendBounded, readIdList, updateIdList } from "@/lib/store/id-list";
import type { Clock, Store } from "@/lib/store/types";
import { analysisKey, EXPIRED_GRACE_S, getAnalysis, isAnalysisId, storeTtl, type Analysis } from "./record";
import { readVisitorToken, sameHash } from "./visitor";

/**
 * Who may read an analysis (results page, status and preview routes): the
 * visitor whose cookie created it, as before accounts, or the signed-in account
 * it is attached to. The visitor check runs first and needs no extra read, so
 * the anonymous path does exactly the reads it did before accounts.
 *
 * The Store has no per-visitor index, so starting an anonymous analysis also
 * appends its id to a short list per visitor; sign-in reads that list to attach
 * the visitor's analyses to the account (parent plan, `confirm` step 4). An
 * account has a list of the same kind (analyses started signed in, and those
 * attached at sign-in), so the account page can offer them for a claim.
 */

export const MAX_INDEXED_ANALYSES = 50;
const visitorAnalysesKey = (ownerHash: string) => `visitor-analyses:${ownerHash}`;
const accountAnalysesKey = (accountId: string) => `account-analyses:${accountId}`;
const ATTACH_ATTEMPTS = 3;

type Deps = { readonly store: Store; readonly clock: Clock; readonly waitUntil?: (task: Promise<unknown>) => void };

/** The visitor and account cookies of a request (or of a page's cookie store). */
export interface Requester {
  readonly visitorToken: string | null;
  readonly accountToken: string | null;
}

export function requesterOf(request: Request): Requester {
  return { visitorToken: readVisitorToken(request), accountToken: readAccountToken(request) };
}

type Owned = Pick<Analysis, "ownerHash" | "accountId">;

/** True when the visitor cookie created the analysis, or the signed-in account is the one it is attached to. */
export function ownedBy(analysis: Owned, visitorToken: string | null, account: Pick<Account, "accountId"> | null): boolean {
  if (visitorToken !== null && sameHash(analysis.ownerHash, sha256Hex(visitorToken))) return true;
  return !!analysis.accountId && account !== null && sameHash(account.accountId, analysis.accountId);
}

/**
 * The one owner lookup for the results page, the status and preview routes and saved reports:
 * the analysis when the requester owns it (else null: another visitor's or account's, unknown or a
 * malformed id), and the signed-in account. The analysis and the session are read in parallel,
 * each at most once; without cookies or with a malformed id nothing is read, and without an
 * account cookie the session is not read (so the anonymous path reads only the analysis).
 */
export async function findOwnedAnalysis(id: string, who: Requester, deps: Deps): Promise<{ analysis: Analysis | null; account: Account | null }> {
  const [analysis, account] = await Promise.all([
    (who.visitorToken || who.accountToken) && isAnalysisId(id) ? getAnalysis(deps.store, id) : null,
    readAccountByToken(who.accountToken, deps),
  ]);
  return { analysis: analysis && ownedBy(analysis, who.visitorToken, account) ? analysis : null, account };
}

/** Lists a new anonymous analysis under its visitor, for attaching at sign-in. Lives as long as the analysis record. */
export async function indexVisitorAnalysis(deps: Deps & { readonly config: Pick<Config, "analysisTtlS"> }, ownerHash: string, id: string): Promise<void> {
  await updateIdList(deps.store, visitorAnalysesKey(ownerHash), appendBounded(id, MAX_INDEXED_ANALYSES), deps.config.analysisTtlS + EXPIRED_GRACE_S);
}

/** Lists analyses under their account (newest last), for the account page. Lives as long as an analysis record. */
export async function indexAccountAnalyses(deps: Deps & { readonly config: Pick<Config, "analysisTtlS"> }, accountId: string, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  await updateIdList(deps.store, accountAnalysesKey(accountId), (list) => ids.reduce((acc, id) => appendBounded(id, MAX_INDEXED_ANALYSES)(acc), list), deps.config.analysisTtlS + EXPIRED_GRACE_S);
}

/** The account's most recent listed analyses that are still stored and attached to it, newest first, at most `max`. */
export async function listAccountAnalyses(deps: Deps, accountId: string, max: number): Promise<Analysis[]> {
  const ids = (await readIdList(deps.store, accountAnalysesKey(accountId))).slice(-max).reverse();
  const found = await Promise.all(ids.map((id) => getAnalysis(deps.store, id)));
  return found.filter((a): a is Analysis => a !== null && !!a.accountId && sameHash(a.accountId, accountId));
}

/**
 * Attaches the visitor's listed analyses that have no account yet to `accountId` (a versioned
 * write per analysis, retried when a concurrent status read wins). An analysis already attached
 * to an account keeps it. Returns how many were attached.
 */
export async function attachVisitorAnalyses(deps: Deps & { readonly config: Pick<Config, "analysisTtlS"> }, ownerHash: string, accountId: string): Promise<number> {
  async function attach(id: string): Promise<boolean> {
    for (let attempt = 0; attempt < ATTACH_ATTEMPTS; attempt++) {
      const analysis = await getAnalysis(deps.store, id);
      if (!analysis || analysis.accountId || !sameHash(analysis.ownerHash, ownerHash)) return false;
      const next: Analysis = { ...analysis, version: analysis.version + 1, accountId };
      if (await deps.store.compareAndSet(analysisKey(id), analysis, next, storeTtl(analysis, deps.clock()))) return true;
    }
    return false;
  }
  const ids = await readIdList(deps.store, visitorAnalysesKey(ownerHash));
  const results = await Promise.all(ids.map(attach));
  // The account page lists them; a failure costs only that list, so it is logged.
  await indexAccountAnalyses(deps, accountId, ids.filter((_, n) => results[n])).catch((e: unknown) => {
    console.error("Account analysis list failed:", e instanceof Error ? e.name : "unknown error");
  });
  return results.filter(Boolean).length;
}
