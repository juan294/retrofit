import { readIdList, updateIdList } from "@/lib/store/id-list";
import type { Clock, Store } from "@/lib/store/types";

/**
 * An account's recent analyses, in one Store value: what the account page needs to offer them for a
 * claim, so it reads no analysis record (each holds a whole snapshot). The analysis record stays the
 * authority: a claim's source checks its owner and host there (src/lib/claims/sources.ts).
 */
export interface AccountAnalysis {
  readonly id: string;
  /** analysisHost: the typed origin's host, then the scored host once the report was read. */
  readonly host: string;
  /** ms: the record leaves the Store then, so the entry is no longer offered. */
  readonly keptUntil: number;
}

type Deps = { readonly store: Store; readonly clock: Clock };

/** Most entries one account's list keeps (the newest). */
export const MAX_ACCOUNT_ANALYSES = 50;
const listKey = (accountId: string) => `account-analyses:${accountId}`;

/** Appends entries (newest last), each analysis once. */
export async function addAccountAnalyses(store: Store, accountId: string, entries: readonly AccountAnalysis[], ttlSeconds: number): Promise<void> {
  if (entries.length === 0) return;
  const added = new Set(entries.map((e) => e.id));
  await updateIdList<AccountAnalysis>(store, listKey(accountId), (list) => [...list.filter((e) => !added.has(e.id)), ...entries].slice(-MAX_ACCOUNT_ANALYSES), ttlSeconds);
}

/** Sets the host of a listed analysis in its place. One read and no write when it is unlisted or unchanged. */
export async function setAccountAnalysisHost(store: Store, accountId: string, id: string, host: string, ttlSeconds: number): Promise<void> {
  const entry = (await readIdList<AccountAnalysis>(store, listKey(accountId))).find((e) => e.id === id);
  if (!entry || entry.host === host) return;
  await updateIdList<AccountAnalysis>(store, listKey(accountId), (list) => list.map((e) => (e.id === id ? { ...e, host } : e)), ttlSeconds);
}

/** The account's most recent analyses that are still stored, newest first, at most `max`. One Store read. */
export async function listAccountAnalyses(deps: Deps, accountId: string, max: number): Promise<AccountAnalysis[]> {
  const now = deps.clock();
  return (await readIdList<AccountAnalysis>(deps.store, listKey(accountId))).filter((e) => now < e.keptUntil).slice(-max).reverse();
}

/** Drops the list (account deletion). The analyses themselves expire on their own. */
export async function forgetAccountAnalyses(store: Store, accountId: string): Promise<void> {
  await store.delete(listKey(accountId));
}
