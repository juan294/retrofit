import type { ObservedBilling } from "@/lib/accounts/data";
import type { ServerDeps } from "@/lib/server/runtime";
import { BillingUnavailable } from "./gateway";
import { billingState, type StripeSubscription } from "./state";

type Deps = Pick<ServerDeps, "config" | "clock" | "billing">;

/**
 * What Stripe says about a customer now, ready to store: the one way billing state enters Retrofit
 * (webhook, reconciliation, checkout). `observedAt` is when the read started, so the newest read wins
 * whatever order the writes arrive in.
 */
export async function readStripe(deps: Deps, customerId: string, options?: { readonly timeoutMs?: number }): Promise<{ readonly observed: ObservedBilling; readonly subscriptions: readonly StripeSubscription[] }> {
  const now = deps.clock();
  const subscriptions = await deps.billing.getSubscriptions(customerId, options);
  return { observed: { ...billingState(subscriptions, deps.config.billing?.prices ?? {}, now), observedAt: new Date(now).toISOString() }, subscriptions };
}

/** Logs a billing failure: an operation and a code only, never an id, an address or a provider message. */
export function logBillingFailure(where: string, e: unknown): void {
  console.error(`${where} failed:`, e instanceof BillingUnavailable ? `${e.operation} (${e.code})` : e instanceof Error ? e.name : "unknown error");
}
