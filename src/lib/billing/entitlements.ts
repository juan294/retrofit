import type { ServerDeps } from "@/lib/server/runtime";
import { planIncludes, type GatedFeature, type PlanId } from "./plans";
import { isOld, refreshBilling } from "./reconcile";
import { entitledPlan, timeBoundPassed } from "./state";
import { logBillingFailure } from "./sync";

/**
 * Whether an account may use a feature that a plan gives (phase-5.md). Before BILLING_START everybody may
 * use everything, decided by one clock comparison: nothing is read. From that instant the account's plan
 * decides (plans.ts). The features every plan has are never asked for here, so an outage never refuses an
 * analysis; the free-analysis limit of visitors without an account is free-limit.ts.
 */

type Deps = Pick<ServerDeps, "config" | "clock" | "store" | "accounts" | "billing">;
/** The clock comparison alone. */
type ClockDeps = Pick<ServerDeps, "config" | "clock">;

/** `plan_required`: the plan lacks the feature. `unavailable`: the plan could not be read, so a paid write waits (a visit never does). */
export type Entitlement = { readonly allowed: true } | { readonly allowed: false; readonly reason: "plan_required" | "unavailable" };

const ALLOWED: Entitlement = { allowed: true };

export function billingStarted(deps: ClockDeps): boolean {
  return deps.clock() >= deps.config.billingStart;
}

/**
 * The plan the account has now (one read), or null when it cannot be read. Only meaningful from
 * BILLING_START on. A plan that only ran out of time in the stored state is read again from Stripe first
 * (bounded and leased, refreshBilling), so a missed renewal webhook does not end it. Until Stripe answers,
 * the plan cannot be read: nobody is told that a plan is missing while that is not known.
 */
export async function accountPlan(deps: Deps, accountId: string): Promise<PlanId | null> {
  try {
    const record = await deps.accounts.getBilling(accountId);
    const now = deps.clock();
    if (!record || !timeBoundPassed(record, now) || !isOld(record, now)) return entitledPlan(record, now);
    const fresh = await refreshBilling(deps, record);
    return fresh === "busy" || fresh === null ? null : entitledPlan(fresh, now);
  } catch (e) {
    logBillingFailure("Reading the billing plan", e);
    return null;
  }
}

export async function entitlement(deps: Deps, accountId: string, feature: GatedFeature): Promise<Entitlement> {
  if (!billingStarted(deps)) return ALLOWED;
  const plan = await accountPlan(deps, accountId);
  if (plan === null) return { allowed: false, reason: "unavailable" };
  return planIncludes(plan, feature) ? ALLOWED : { allowed: false, reason: "plan_required" };
}
