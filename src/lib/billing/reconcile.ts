import type { BillingRecord } from "@/lib/accounts/data";
import { countClientWindow } from "@/lib/fetch/limits";
import type { ServerDeps } from "@/lib/server/runtime";
import type { PlanId } from "./plans";
import { entitledPlan } from "./state";
import { logBillingFailure, readStripe } from "./sync";
import { withTimeout } from "./timeout";

/** A stored state this old is read again from Stripe when its owner opens the account page. */
export const RECONCILE_AFTER_MS = 10 * 60_000;
/** The lease of one read (released when it ends), so tabs and instances never read one account at the same time. */
const LEASE_S = 10;
/** Reads of Stripe per account and hour on the account page; past them the stored state is shown. */
const READS_PER_HOUR = 60;
/** The longest the page waits for Stripe. */
const WAIT_MS = 2_500;

export interface AccountBilling {
  /** The plan the account has now. */
  readonly plan: PlanId;
  readonly record: BillingRecord | null;
  /** A purchase may be on its way and Stripe has not shown it: "Activating your plan. Reload in a minute." */
  readonly activating: boolean;
}

type Deps = Pick<ServerDeps, "config" | "clock" | "store" | "accounts" | "billing">;

/**
 * The account's billing for its account page. A state older than RECONCILE_AFTER_MS, and any state when
 * the visitor returns from checkout, is read again from Stripe first (a missed webhook is fixed here),
 * once at a time per account (a Store lease), at most READS_PER_HOUR times, and for at most `waitMs`. When
 * Stripe cannot be asked, the stored state stands. Throws only when the billing record cannot be read.
 */
export async function accountBilling(deps: Deps, accountId: string, o: { readonly checkout: boolean; readonly waitMs?: number }): Promise<AccountBilling> {
  const record = await deps.accounts.getBilling(accountId);
  if (!record) return { plan: "free", record: null, activating: false };
  const overview = (r: BillingRecord, waiting: boolean): AccountBilling => {
    const plan = entitledPlan(r, deps.clock());
    return { plan, record: r, activating: waiting && plan === "free" };
  };
  const old = record.stateAt === null || deps.clock() - Date.parse(record.stateAt) >= RECONCILE_AFTER_MS;
  if (!old && !o.checkout) return overview(record, false);

  const fresh = await withTimeout(refresh(deps, record), o.waitMs ?? WAIT_MS);
  if (fresh === "busy") return overview(record, o.checkout);
  // Not read: say so only where a purchase may be waiting, never for a plan that ended.
  if (fresh === null) return overview(record, o.checkout || record.status === "none" || record.status === "incomplete");
  return overview(fresh, o.checkout);
}

/** The state read from Stripe and stored; "busy" while another read runs or past the hourly limit; null when Stripe or the Store cannot be asked. Never throws. */
async function refresh(deps: Deps, record: BillingRecord): Promise<BillingRecord | "busy" | null> {
  const leaseKey = `billing-reconcile:${record.accountId}`;
  try {
    const token = await deps.store.acquireLease(leaseKey, LEASE_S);
    if (token === null) return "busy";
    try {
      if (!(await countClientWindow(deps.store, "billing-read", READS_PER_HOUR, record.accountId, deps.clock())).ok) return "busy";
      const { observed } = await readStripe(deps, record.customerId, { timeoutMs: WAIT_MS });
      const applied = await deps.accounts.applyBillingState(record.customerId, observed);
      return "billing" in applied ? applied.billing : null;
    } finally {
      await deps.store.releaseLease(leaseKey, token);
    }
  } catch (e) {
    logBillingFailure("Billing reconciliation", e);
    return null;
  }
}
