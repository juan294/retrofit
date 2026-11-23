import { entitlement } from "@/lib/billing/entitlements";
import type { ServerDeps } from "@/lib/server/runtime";
import type { GatedFeature } from "@/lib/billing/plans";
import { PLAN_TEXT } from "@/lib/site/plan-texts";
import { json } from "./json";

const planUnavailable = () => json(503, { error: "billing_unavailable", message: PLAN_TEXT.unavailable });

/**
 * Null when the account may use the feature (always before BILLING_START, with no read). Otherwise 403
 * plan_required with the way to the plans, or 503 billing_unavailable when the plan cannot be read: a
 * paid write then waits, and nothing is changed. `unavailable`: another answer for that.
 */
export async function refuseFeature(deps: Pick<ServerDeps, "config" | "clock" | "store" | "accounts" | "billing">, accountId: string, feature: GatedFeature, unavailable = planUnavailable): Promise<Response | null> {
  const e = await entitlement(deps, accountId, feature);
  if (e.allowed) return null;
  if (e.reason === "unavailable") return unavailable();
  return json(403, { error: "plan_required", message: PLAN_TEXT.required[feature], href: "/pricing" });
}
