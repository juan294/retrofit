import { isPaidPlan, PLANS, type PaidPlanId, type PlanId } from "./plans";

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
  /** ISO 8601: the end of the current period, or null. */
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
  /** ISO 8601: while past due, when Retrofit first saw that; else null. Stored once per unpaid time (AccountData keeps the first). */
  readonly unpaidSince: string | null;
}

export type StatusRule = "period_end_plus_grace" | "unpaid_plus_grace" | "none";

/** After the paid period an active plan waits this long for its renewal to be read (a late webhook). Not when it was cancelled. */
export const RENEWAL_GRACE_MS = 3 * 24 * 3600_000;
/**
 * A plan whose payment failed keeps its access this long, while Stripe retries, from the first time
 * Retrofit saw it past due. Not from the period's start: a switch whose payment fails in the middle of a
 * paid period would end at once. That first time is never before the unpaid period's start, so it is also
 * the later of the two.
 */
export const UNPAID_GRACE_MS = 7 * 24 * 3600_000;

/**
 * Access by status, always up to an instant, so a lost webhook can never leave a plan open for ever.
 * `active`, `trialing`: until the period ends, and RENEWAL_GRACE_MS more unless it was cancelled.
 * `past_due`: Stripe is retrying the payment; UNPAID_GRACE_MS from when Retrofit first saw it.
 * `unpaid`: the retries failed. `incomplete`, `incomplete_expired`: the first payment never succeeded.
 * `paused`: a trial ended without a payment method. `canceled`: ended now (a cancellation at the period
 * end keeps the status `active` until then). Any other status: none.
 */
export const STATUS_RULES: Readonly<Record<string, StatusRule>> = {
  active: "period_end_plus_grace",
  trialing: "period_end_plus_grace",
  past_due: "unpaid_plus_grace",
  unpaid: "none",
  incomplete: "none",
  incomplete_expired: "none",
  paused: "none",
  canceled: "none",
};

const ruleOf = (status: string): StatusRule => (Object.hasOwn(STATUS_RULES, status) ? STATUS_RULES[status]! : "none");

type Access = Pick<BillingState, "status" | "currentPeriodEnd" | "cancelAtPeriodEnd" | "unpaidSince">;

/** When the state's access ends (ms since the epoch), or null when its status gives none. */
export function accessUntil(s: Access): number | null {
  const rule = ruleOf(s.status);
  if (rule === "period_end_plus_grace") return s.currentPeriodEnd === null ? null : Date.parse(s.currentPeriodEnd) + (s.cancelAtPeriodEnd ? 0 : RENEWAL_GRACE_MS);
  if (rule === "unpaid_plus_grace") return s.unpaidSince === null ? null : Date.parse(s.unpaidSince) + UNPAID_GRACE_MS;
  return null;
}

function givesAccess(s: Access, now: number): boolean {
  const until = accessUntil(s);
  return until !== null && now < until;
}

/** True when the status would give access but its time ran out in the stored state: Stripe may know of a renewal, so it is worth reading again. */
export function timeBoundPassed(s: Access, now: number): boolean {
  return ruleOf(s.status) !== "none" && !givesAccess(s, now);
}

/** The plan the stored state gives now: its plan while the state gives access, else free. */
export function entitledPlan(state: (Access & Pick<BillingState, "plan">) | null, now: number): PlanId {
  return state && givesAccess(state, now) ? state.plan : "free";
}

/** The order of the plans table: a later plan includes everything of an earlier one. */
const rankOf = (id: PlanId): number => PLANS.findIndex((p) => p.id === id);

/** The price ids that mean each paid plan: the first is for sale, the others are kept for their subscribers. */
export type PlanPrices = Readonly<Partial<Record<PaidPlanId, readonly string[]>>>;

function planOfPrices(priceIds: readonly string[], prices: PlanPrices): PlanId {
  return PLANS.findLast(({ id }) => isPaidPlan(id) && prices[id]?.some((price) => priceIds.includes(price)))?.id ?? "free";
}

const NONE: BillingState = { plan: "free", status: "none", currentPeriodEnd: null, cancelAtPeriodEnd: false, subscriptionId: null, unpaidSince: null };

/** The state to store for a customer: the subscription that gives the highest plan now, else the newest one, else none. */
export function billingState(subscriptions: readonly StripeSubscription[], prices: PlanPrices, now: number): BillingState {
  const best = subscriptions
    .map((s) => ({ ...s, unpaidSince: s.status === "past_due" ? new Date(now).toISOString() : null }))
    .map((s) => ({ s, plan: planOfPrices(s.priceIds, prices), access: givesAccess(s, now) }))
    .sort((x, y) => (y.access ? rankOf(y.plan) : 0) - (x.access ? rankOf(x.plan) : 0) || Number(y.access) - Number(x.access) || y.s.created - x.s.created)[0];
  if (!best) return NONE;
  const { s, plan } = best;
  return { plan, status: s.status, currentPeriodEnd: s.currentPeriodEnd, cancelAtPeriodEnd: s.cancelAtPeriodEnd, subscriptionId: s.id, unpaidSince: s.unpaidSince };
}

/** Statuses of a subscription that can still charge: a second checkout would charge twice, so it is sent to the portal. */
const OPEN = new Set(["active", "trialing", "past_due", "unpaid", "paused"]);

export function needsPortal(subscriptions: readonly StripeSubscription[]): boolean {
  return subscriptions.some((s) => OPEN.has(s.status));
}
