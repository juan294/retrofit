import { readAccountByToken, readAccountToken } from "@/lib/accounts/session";
import type { Config } from "@/lib/config";
import { sha256Hex } from "@/lib/security/tokens";
import { appendBounded, readIdList, updateIdList } from "@/lib/store/id-list";
import type { Clock, Store } from "@/lib/store/types";
import { analysisKey, EXPIRED_GRACE_S, getAnalysis, storeTtl, type Analysis } from "./record";
import { readVisitorToken, sameHash } from "./visitor";

/**
 * Who may read an analysis (results page, status and preview routes): the
 * visitor whose cookie created it, as before accounts, or the signed-in account
 * it is attached to. The visitor check runs first and needs no extra read, so
 * the anonymous path does exactly the reads it did before accounts.
 *
 * The Store has no per-visitor index, so starting an anonymous analysis also
 * appends its id to a short list per visitor; sign-in reads that list to attach
 * the visitor's analyses to the account (parent plan, `confirm` step 4).
 */

export const MAX_INDEXED_ANALYSES = 50;
const visitorAnalysesKey = (ownerHash: string) => `visitor-analyses:${ownerHash}`;
const ATTACH_ATTEMPTS = 3;

type Deps = { readonly store: Store; readonly clock: Clock };

/** The visitor and account cookies of a request (or of a page's cookie store). */
export interface Requester {
  readonly visitorToken: string | null;
  readonly accountToken: string | null;
}

export function requesterOf(request: Request): Requester {
  return { visitorToken: readVisitorToken(request), accountToken: readAccountToken(request) };
}

/** True when the requester owns the analysis: the visitor cookie, or the attached account's session. */
export async function ownsAnalysis(analysis: Pick<Analysis, "ownerHash" | "accountId">, who: Requester, deps: Deps): Promise<boolean> {
  if (who.visitorToken && sameHash(analysis.ownerHash, sha256Hex(who.visitorToken))) return true;
  if (!analysis.accountId || !who.accountToken) return false;
  const account = await readAccountByToken(who.accountToken, deps);
  return account !== null && sameHash(account.accountId, analysis.accountId);
}

/** Lists a new anonymous analysis under its visitor, for attaching at sign-in. Lives as long as the analysis record. */
export async function indexVisitorAnalysis(deps: Deps & { readonly config: Pick<Config, "analysisTtlS"> }, ownerHash: string, id: string): Promise<void> {
  await updateIdList(deps.store, visitorAnalysesKey(ownerHash), appendBounded(id, MAX_INDEXED_ANALYSES), deps.config.analysisTtlS + EXPIRED_GRACE_S);
}

/**
 * Attaches the visitor's listed analyses that have no account yet to `accountId` (a versioned
 * write per analysis, retried when a concurrent status read wins). An analysis already attached
 * to an account keeps it. Returns how many were attached.
 */
export async function attachVisitorAnalyses(deps: Deps, ownerHash: string, accountId: string): Promise<number> {
  let attached = 0;
  for (const id of await readIdList(deps.store, visitorAnalysesKey(ownerHash))) {
    for (let attempt = 0; attempt < ATTACH_ATTEMPTS; attempt++) {
      const analysis = await getAnalysis(deps.store, id);
      if (!analysis || analysis.accountId || !sameHash(analysis.ownerHash, ownerHash)) break;
      const next: Analysis = { ...analysis, version: analysis.version + 1, accountId };
      if (await deps.store.compareAndSet(analysisKey(id), analysis, next, storeTtl(analysis, deps.clock()))) {
        attached++;
        break;
      }
    }
  }
  return attached;
}
