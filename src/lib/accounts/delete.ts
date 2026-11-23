import type { ServerDeps } from "@/lib/server/runtime";
import { endAccountSessions, type Account } from "./session";

/**
 * `deleted`: everything is gone. `nothing_deleted`: a step before the data deletion failed, so no
 * account data was deleted (the account's other browsers may have been signed out). `partial`:
 * the data is deleted but the Supabase Auth user is not; this browser stays signed in, and a
 * retry finishes the deletion.
 */
export type DeleteOutcome = "deleted" | "nothing_deleted" | "partial";

/**
 * Deletes the signed-in account (parent plan, "Accounts and sessions"). The order keeps every
 * failure before the auth user's deletion free of data loss, and makes a retry safe:
 *
 * 1. Ask the provider for the user first: an outage there stops before anything is deleted.
 * 2. Phase 5 inserts "cancel the active subscription" here; its failure returns nothing_deleted.
 * 3. End the account's other sessions (this one stays, so the visitor can retry).
 * 4. Delete every account row in one atomic step (AccountData.deleteAccountData).
 * 5. Delete the Supabase Auth user, last. A user already gone counts as deleted.
 * 6. End this session and drop the session index. A failure is logged; the handler clears the cookie anyway.
 */
export async function deleteAccount(deps: Pick<ServerDeps, "store" | "accounts" | "auth">, account: Pick<Account, "accountId" | "sessionHash">): Promise<DeleteOutcome> {
  const fail = (step: string, e: unknown) => console.error(`Account deletion ${step} failed:`, e instanceof Error ? e.name : "unknown error");
  try {
    await deps.auth.getUser(account.accountId);
    // Phase 5: cancel the account's active subscription here, before any deletion.
    await endAccountSessions(deps.store, account.accountId, account.sessionHash);
    await deps.accounts.deleteAccountData(account.accountId);
  } catch (e) {
    fail("before data deletion", e);
    return "nothing_deleted";
  }
  try {
    await deps.auth.deleteUser(account.accountId);
  } catch (e) {
    fail("of the auth user", e);
    return "partial";
  }
  await endAccountSessions(deps.store, account.accountId).catch((e: unknown) => fail("of this session", e));
  return "deleted";
}
