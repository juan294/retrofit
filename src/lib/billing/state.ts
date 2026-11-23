import type { PaidPlanId, PlanId } from "./plans";

/**
 * What a customer's Stripe subscriptions mean for Retrofit: the plan (by price id only, never by
 * metadata or an amount) and whether its status gives access now. Pure functions, shared by the
 * webhook, the reconciliation, the entitlement check and the tests.
 */

/** One subscription as the gateway reads it from Stripe. */
export interface StripeSubscription {
  readonly id: string;
  /** Stripe's status, as Stripe names it (new statuses may appear). */
  readonly status: string;
  /** The price ids of its items. */
  readonly priceIds: readonly string[];
  /** ISO 8601: the end of the paid period, or null. */
  readonly currentPeriodEnd: string | null;
  readonly cancelAtPeriodEnd: boolean;
  /** Seconds since the epoch. */
  readonly created: number;
}

/** The stored subscription state of one customer (billing_customers). */
export interface BillingState {
  /** The plan its price buys, whether or not the status gives access. */
  readonly plan: PlanId;
  /** Stripe's subscription status, or "none" before the first subscription. */
  readonly status: string;
  readonly currentPeriodEnd: string | null;
  readonly cancelAtPeriodEnd: boolean;
  readonly subscriptionId: string | null;
}

export type StatusRule = "entitled" | "until_period_end" | "none";

/**
 * Access by status. `past_due`: Stripe is still retrying the payment, so access continues until the
 * stored period ends. `unpaid`: the retries failed. `incomplete`, `incomplete_expired`: the first
 * payment never succeeded. `paused`: a trial ended without a payment method. `canceled`: ended now
 * (a cancellation at the period end keeps the status `active` until then). Any other status: none.
 */
export const STATUS_RULES: Readonly<Record<string, StatusRule>> = {
  active: "entitled",
  trialing: "entitled",
  past_due: "until_period_end",
  unpaid: "none",
  incomplete: "none",
  incomplete_expired: "none",
  paused: "none",
  canceled: "none",
};

const ruleOf = (status: string): StatusRule => (Object.hasOwn(STATUS_RULES, status) ? STATUS_RULES[status]! : "none");

function givesAccess(s: Pick<BillingState, "status" | "currentPeriodEnd">, now: number): boolean {
  const rule = ruleOf(s.status);
  if (rule === "until_period_end") return s.currentPeriodEnd !== null && now < Date.parse(s.currentPeriodEnd);
  return rule === "entitled";
}

/** The plan the stored state gives now: its plan while the status gives access, else free. */
export function entitledPlan(state: Pick<BillingState, "plan" | "status" | "currentPeriodEnd"> | null, now: number): PlanId {
  return state && givesAccess(state, now) ? state.plan : "free";
}

const RANK: Readonly<Record<PlanId, number>> = { free: 0, pro: 1, agency: 2 };

function planOfPrices(priceIds: readonly string[], prices: Readonly<Partial<Record<PaidPlanId, string>>>): PlanId {
  if (prices.agency && priceIds.includes(prices.agency)) return "agency";
  return prices.pro && priceIds.includes(prices.pro) ? "pro" : "free";
}

const NONE: BillingState = { plan: "free", status: "none", currentPeriodEnd: null, cancelAtPeriodEnd: false, subscriptionId: null };

/** The state to store for a customer: the subscription that gives the highest plan now, else the newest one, else none. */
export function billingState(subscriptions: readonly StripeSubscription[], prices: Readonly<Partial<Record<PaidPlanId, string>>>, now: number): BillingState {
  const best = subscriptions
    .map((s) => ({ s, plan: planOfPrices(s.priceIds, prices), access: givesAccess(s, now) }))
    .sort((x, y) => (y.access ? RANK[y.plan] : 0) - (x.access ? RANK[x.plan] : 0) || Number(y.access) - Number(x.access) || y.s.created - x.s.created)[0];
  if (!best) return NONE;
  const { s, plan } = best;
  return { plan, status: s.status, currentPeriodEnd: s.currentPeriodEnd, cancelAtPeriodEnd: s.cancelAtPeriodEnd, subscriptionId: s.id };
}

/** Statuses of a subscription that can still charge: a second checkout would charge twice, so it is sent to the portal. */
const OPEN = new Set(["active", "trialing", "past_due", "unpaid", "paused"]);

export function needsPortal(subscriptions: readonly StripeSubscription[]): boolean {
  return subscriptions.some((s) => OPEN.has(s.status));
}
