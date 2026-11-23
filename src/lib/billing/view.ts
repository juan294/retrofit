import { dateText } from "@/lib/site/account-texts";
import { BILLING_TEXT as T } from "@/lib/site/billing-texts";
import { planOf } from "./plans";
import type { AccountBilling } from "./reconcile";
import { accessUntil } from "./state";

/** An account's billing as its account page shows it. No Stripe id. */
export interface BillingView {
  readonly planName: string;
  /** Renewal, end or payment problem; null when there is nothing to say. */
  readonly detail: string | null;
  /** The account has a Stripe customer, so the portal opens. */
  readonly manage: boolean;
  readonly activating: boolean;
}

function detailOf({ plan, record, activating }: AccountBilling, now: number): string | null {
  if (!record || record.status === "none" || activating) return null;
  const date = record.currentPeriodEnd && dateText(record.currentPeriodEnd);
  if (plan !== "free") {
    if (!date) return null;
    // The day access really ends, not the end of the unpaid month.
    const until = accessUntil(record);
    if (record.status === "past_due") return until === null ? null : T.pastDue(dateText(new Date(until).toISOString()));
    if (record.cancelAtPeriodEnd) return T.ends(date);
    return Date.parse(record.currentPeriodEnd!) <= now ? T.renewalPending(date) : T.renews(date);
  }
  if (record.plan === "free") return null;
  return record.status === "canceled" ? T.ended : T.notPaid;
}

export function billingView(b: AccountBilling, now: number): BillingView {
  return { planName: planOf(b.plan).name, detail: detailOf(b, now), manage: b.record !== null, activating: b.activating };
}
