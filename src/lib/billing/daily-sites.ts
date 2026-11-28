import type { Config } from "@/lib/config";
import { countOnce, nextUtcMidnight, shortHash, ttlUntil, utcDay } from "@/lib/fetch/limits";
import type { Store } from "@/lib/store/types";
import type { PlanId } from "./plans";

type Limits = Pick<Config, "accountSitesPerDay" | "crawlMaxHostsPerDay">;

/**
 * Distinct sites an account of the plan may analyze and score (with its API keys) in a UTC day: never more than half of
 * the shared cap. `plan` null: it could not be read, and an outage does not stop an analysis, so the highest limit applies.
 */
export function sitesPerDay(config: Limits, plan: PlanId | null): number {
  const limit = plan === null ? Math.max(...Object.values(config.accountSitesPerDay)) : config.accountSitesPerDay[plan];
  return Math.max(1, Math.min(limit, Math.floor(config.crawlMaxHostsPerDay / 2)));
}

export type DailySites = { readonly ok: true } | { readonly ok: false; readonly limit: number; readonly retryAt: number } | { readonly ok: false; readonly undecided: true };

/**
 * Counts one site of the account's day (from BILLING_START on), each origin once, so that one account
 * cannot use the crawl capacity everybody shares.
 */
export async function countAccountSite(deps: { readonly store: Store; readonly config: Limits }, accountId: string, plan: PlanId | null, origin: string, now: number): Promise<DailySites> {
  const limit = sitesPerDay(deps.config, plan);
  const day = utcDay(now);
  const midnight = nextUtcMidnight(now);
  const decision = await countOnce(deps.store, `account-origin-day:${accountId}:${day}:${shortHash(origin)}`, `account-sites:${accountId}:${day}`, ttlUntil(midnight, now), limit);
  if (decision === "undecided") return { ok: false, undecided: true };
  return decision === "admitted" ? { ok: true } : { ok: false, limit, retryAt: midnight };
}
