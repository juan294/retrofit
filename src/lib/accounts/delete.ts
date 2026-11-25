import { forgetAccountAnalyses } from "@/lib/analysis/account-list";
import { logBillingFailure, readStripe } from "@/lib/billing/sync";
import type { ServerDeps } from "@/lib/server/runtime";
import type { BillingRecord } from "./data";
import { abandonAccountDeletion, beginAccountDeletion, endAccountSessions, endLastAccountSession, type Account } from "./session";

/**
 * How far the deletion came. `deleted`: everything is gone. `subscription`: Stripe did not confirm the
 * cancellation, and nothing was changed or deleted (no session ended either). `data`: it stopped before or
 * at the data deletion, so no account data was deleted (the account's other browsers may have been signed
 * out). `user`: the data is deleted but the Supabase Auth user is not; this browser stays signed in, and a
 * retry finishes the deletion. `cancelled`: a plan was already cancelled, which the visitor must be told.
 */
export interface DeleteOutcome {
  readonly stage: "deleted" | "subscription" | "data" | "user";
  readonly cancelled: boolean;
}

/**
 * Deletes the signed-in account (parent plan, "Accounts and sessions"). The order keeps every
 * failure before the auth user's deletion free of data loss, and makes a retry safe:
 *
 * 1. Ask the provider for the user first: an outage there stops before anything is deleted.
 * 2. Close the customer's open checkouts and cancel every subscription, at once. A failure stops here;
 *    a repeat of a cancellation that succeeded cancels nothing more.
 *    The state it leaves is stored, so a page that shows the account after a later failure is right.
 * 3. Refuse new sessions of the account (until the deletion fails), then end its other sessions (this one
 *    stays, so the visitor can retry).
 * 4. Delete every account row in one atomic step (AccountData.deleteAccountData), which also marks the
 *    customer as deleted and keeps a checkout request under way from binding one.
 * 5. Delete the Supabase Auth user. A user already gone counts as deleted.
 * 6. Cancel again: a checkout that was already being paid in step 2 may have completed since. A
 *    failure is logged, as the next step covers it.
 * 7. End this session, drop the session index and the account's list of analyses. A failure is logged; the
 *    handler clears the cookie anyway.
 *
 * A checkout paid even later reaches the webhook as an event of a customer that is marked as deleted,
 * which cancels it (src/lib/api/billing-webhook.ts).
 *
 * One moment has no mark: another tab of this browser opens a checkout between steps 4 and 5. Its record
 * goes with the auth user, as a row cleared by hand would, so nothing proves a deletion: a later payment
 * raises an alert for the owner and cancels nothing.
 */
export async function deleteAccount(deps: Pick<ServerDeps, "config" | "clock" | "store" | "accounts" | "auth" | "billing">, account: Pick<Account, "accountId" | "sessionHash">): Promise<DeleteOutcome> {
  const fail = (step: string, e: unknown) => console.error(`Account deletion ${step} failed:`, e instanceof Error ? e.name : "unknown error");
  let record: BillingRecord | null;
  try {
    await deps.auth.getUser(account.accountId);
    record = await deps.accounts.getBilling(account.accountId);
  } catch (e) {
    fail("before data deletion", e);
    return { stage: "data", cancelled: false };
  }
  // True when a plan ended by this deletion, now or in an earlier try.
  let cancelled = record?.status === "canceled";
  try {
    if (record && (await deps.billing.cancelSubscriptions(record.customerId)) > 0) cancelled = true;
  } catch (e) {
    logBillingFailure("Account deletion, cancelling the subscription", e);
    return { stage: "subscription", cancelled };
  }
  if (record && cancelled) await storeState(deps, record);
  // A failure below lets the owner sign in again. When even that fails, the marker ends by itself.
  const abandon = () => abandonAccountDeletion(deps.store, account.accountId).catch((e: unknown) => fail("of its marker", e));
  try {
    await beginAccountDeletion(deps.store, account.accountId);
    await endAccountSessions(deps.store, account.accountId, account.sessionHash);
    await deps.accounts.deleteAccountData(account.accountId);
  } catch (e) {
    fail("before data deletion", e);
    await abandon();
    return { stage: "data", cancelled };
  }
  try {
    await deps.auth.deleteUser(account.accountId);
  } catch (e) {
    fail("of the auth user", e);
    await abandon();
    return { stage: "user", cancelled };
  }
  if (record) await deps.billing.cancelSubscriptions(record.customerId).catch((e: unknown) => logBillingFailure("Account deletion, the last subscription check", e));
  await Promise.all([endLastAccountSession(deps.store, account), forgetAccountAnalyses(deps.store, account.accountId)]).catch((e: unknown) => fail("of this session", e));
  return { stage: "deleted", cancelled };
}

/** Stores the cancelled state. A failure is logged: the webhook and the account page read it again. */
async function storeState(deps: Pick<ServerDeps, "config" | "clock" | "accounts" | "billing">, record: BillingRecord): Promise<void> {
  try {
    const { observed } = await readStripe(deps, record);
    await deps.accounts.applyBillingState(record.customerId, observed);
  } catch (e) {
    logBillingFailure("Account deletion, storing the cancelled plan", e);
  }
}
