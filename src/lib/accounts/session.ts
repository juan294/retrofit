import type { VerifiedAccount } from "@/lib/auth/gateway";
import { newToken, sha256Hex, TOKEN_PATTERN } from "@/lib/security/tokens";
import { appendBounded, readIdList, updateIdList } from "@/lib/store/id-list";
import type { Clock, Store } from "@/lib/store/types";

/**
 * Retrofit's own account sessions (parent plan, "Accounts and sessions").
 * After Supabase Auth verifies the email link, Retrofit issues `retrofit_account`:
 * a random 128-bit id. The Store keeps the record under the id's SHA-256 only,
 * so a Store dump signs nobody in, and no secret is needed to check a cookie.
 *
 * The record is the session: it lives 30 days after its last use (refreshed at
 * most once a day, so a signed-in visitor costs one read per request). The
 * cookie itself carries the browser maximum lifetime; a cookie whose record is
 * gone or expired is simply not signed in. Each account keeps at most
 * MAX_SESSIONS_PER_ACCOUNT sessions in an index, so sign-out everywhere and
 * account deletion can find every one of them.
 */

export const ACCOUNT_COOKIE = "retrofit_account";
export const ACCOUNT_SESSION_TTL_S = 30 * 24 * 3600;
/** A record is rewritten (its TTL renewed) when it was last refreshed this long ago. */
export const ACCOUNT_SESSION_REFRESH_S = 24 * 3600;
/** The browser's limit for a cookie lifetime (400 days); the Store record decides the session's end. */
export const ACCOUNT_COOKIE_MAX_AGE_S = 400 * 24 * 3600;
export const MAX_SESSIONS_PER_ACCOUNT = 10;

interface AccountSessionRecord {
  readonly version: number;
  readonly accountId: string;
  /** Lower case; shown on the account page. Never logged. */
  readonly email: string;
  readonly createdAt: number;
  readonly refreshedAt: number;
}

/** The signed-in account of a request. */
export interface Account {
  readonly accountId: string;
  readonly email: string;
  /** SHA-256 of the session id: this session's Store key. */
  readonly sessionHash: string;
}

type SessionDeps = { readonly store: Store; readonly clock: Clock };

const sessionKey = (hash: string) => `account-session:${hash}`;
const accountSessionsKey = (accountId: string) => `account-sessions:${accountId}`;

export function accountSetCookie(token: string, secure: boolean): string {
  const attrs = [`${ACCOUNT_COOKIE}=${token}`, "HttpOnly", "SameSite=Lax", "Path=/", `Max-Age=${ACCOUNT_COOKIE_MAX_AGE_S}`];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

export function accountClearCookie(secure: boolean): string {
  const attrs = [`${ACCOUNT_COOKIE}=`, "HttpOnly", "SameSite=Lax", "Path=/", "Max-Age=0"];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

/** The value of cookie `name` in a Cookie header, or null. */
export function cookieValue(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq !== -1 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/** The account cookie's session id, or null when absent or malformed. */
export function readAccountToken(request: Request): string | null {
  const value = cookieValue(request.headers.get("cookie"), ACCOUNT_COOKIE);
  return value !== null && TOKEN_PATTERN.test(value) ? value : null;
}

/** Starts a session for a verified account and returns its id (for the cookie). A sign-in past the limit ends the account's oldest session. */
export async function createAccountSession(deps: SessionDeps, account: VerifiedAccount): Promise<{ token: string }> {
  const token = newToken();
  const hash = sha256Hex(token);
  const now = deps.clock();
  const record: AccountSessionRecord = { version: 1, accountId: account.userId, email: account.email, createdAt: now, refreshedAt: now };
  await deps.store.set(sessionKey(hash), record, ACCOUNT_SESSION_TTL_S);
  const { before, after } = await updateIdList(deps.store, accountSessionsKey(account.userId), appendBounded(hash, MAX_SESSIONS_PER_ACCOUNT), ACCOUNT_SESSION_TTL_S);
  for (const evicted of before.filter((h) => !after.includes(h))) await deps.store.delete(sessionKey(evicted));
  return { token };
}

/** The account of a session id, or null. Slides the session (at most once a day). Throws when the Store is unavailable. */
export async function readAccountByToken(token: string | null | undefined, deps: SessionDeps): Promise<Account | null> {
  if (!token || !TOKEN_PATTERN.test(token)) return null;
  const hash = sha256Hex(token);
  const record = await deps.store.get<AccountSessionRecord>(sessionKey(hash));
  if (!record) return null;
  const now = deps.clock();
  if (now - record.refreshedAt >= ACCOUNT_SESSION_REFRESH_S * 1000) {
    // A lost compare-and-set means a concurrent request refreshed it first.
    const refreshed = await deps.store.compareAndSet(sessionKey(hash), record, { ...record, version: record.version + 1, refreshedAt: now }, ACCOUNT_SESSION_TTL_S);
    // The index must outlive every session it lists.
    if (refreshed) await updateIdList(deps.store, accountSessionsKey(record.accountId), (ids) => (ids.includes(hash) ? ids : appendBounded(hash, MAX_SESSIONS_PER_ACCOUNT)(ids)), ACCOUNT_SESSION_TTL_S);
  }
  return { accountId: record.accountId, email: record.email, sessionHash: hash };
}

/** The request's signed-in account (readAccountByToken on the account cookie). */
export function readAccount(request: Request, deps: SessionDeps): Promise<Account | null> {
  return readAccountByToken(readAccountToken(request), deps);
}

/** Ends one session (sign-out). */
export async function endAccountSession(store: Store, account: Pick<Account, "accountId" | "sessionHash">): Promise<void> {
  await store.delete(sessionKey(account.sessionHash));
  await updateIdList(store, accountSessionsKey(account.accountId), (ids) => ids.filter((h) => h !== account.sessionHash), ACCOUNT_SESSION_TTL_S);
}

/** Ends every session of the account except `keep` (a session hash), if given. */
export async function endAccountSessions(store: Store, accountId: string, keep?: string): Promise<void> {
  const key = accountSessionsKey(accountId);
  for (const hash of await readIdList(store, key)) if (hash !== keep) await store.delete(sessionKey(hash));
  if (keep) await updateIdList(store, key, (ids) => ids.filter((h) => h === keep), ACCOUNT_SESSION_TTL_S);
  else await store.delete(key);
}
