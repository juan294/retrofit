import type { ServerDeps } from "@/lib/server/runtime";
import { planIncludes, type Feature, type PlanId } from "./plans";
import { entitledPlan } from "./state";

/**
 * Who may use a feature (phase-5.md). Before BILLING_START everybody may use everything, decided by one
 * clock comparison: nothing is read. From that instant the account's plan decides (plans.ts); a visitor
 * without an account has the Free features. The free-analysis limit of visitors is free-limit.ts.
 */

type Deps = Pick<ServerDeps, "config" | "clock" | "accounts">;

/** `plan_required`: the plan lacks the feature. `unavailable`: the plan could not be read, so a paid write waits (a visit never does). */
export type Entitlement = { readonly allowed: true } | { readonly allowed: false; readonly reason: "plan_required" | "unavailable" };

const ALLOWED: Entitlement = { allowed: true };

export function billingStarted(deps: Pick<Deps, "config" | "clock">): boolean {
  return deps.clock() >= deps.config.billingStart;
}

/** The plan the account has now (one read), or null when it cannot be read. Only meaningful from BILLING_START on. */
export async function accountPlan(deps: Deps, accountId: string): Promise<PlanId | null> {
  try {
    return entitledPlan(await deps.accounts.getBilling(accountId), deps.clock());
  } catch (e) {
    console.error("Reading the billing plan failed:", e instanceof Error ? e.name : "unknown error");
    return null;
  }
}

export async function entitlement(deps: Deps, accountId: string | null, feature: Feature): Promise<Entitlement> {
  if (!billingStarted(deps)) return ALLOWED;
  // A feature every plan has needs no read, so an outage never refuses an analysis.
  if (planIncludes("free", feature)) return ALLOWED;
  if (accountId === null) return { allowed: false, reason: "plan_required" };
  const plan = await accountPlan(deps, accountId);
  if (plan === null) return { allowed: false, reason: "unavailable" };
  return planIncludes(plan, feature) ? ALLOWED : { allowed: false, reason: "plan_required" };
}
