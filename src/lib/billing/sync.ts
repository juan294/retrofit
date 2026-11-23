import type { BillingRecord, ObservedBilling } from "@/lib/accounts/data";
import type { ServerDeps } from "@/lib/server/runtime";
import { BillingUnavailable } from "./gateway";
import { billingState, type StripeSubscription } from "./state";

type Deps = Pick<ServerDeps, "config" | "clock" | "billing">;

/**
 * What Stripe says about a customer now, ready to store: the one way billing state enters Retrofit
 * (webhook, reconciliation, checkout). `observedAt` is when the read started, so the newest read wins
 * whatever order the writes arrive in. `known` is the record as this caller last saw it: this read starts
 * after that one was stored, so it is always newer, also on an instance whose clock is behind.
 */
export async function readStripe(deps: Deps, known: Pick<BillingRecord, "customerId" | "stateAt">, options?: { readonly timeoutMs?: number }): Promise<{ readonly observed: ObservedBilling; readonly subscriptions: readonly StripeSubscription[] }> {
  const now = deps.clock();
  const observedAt = known.stateAt === null ? now : Math.max(now, Date.parse(known.stateAt) + 1);
  const subscriptions = await deps.billing.getSubscriptions(known.customerId, options);
  return { observed: { ...billingState(subscriptions, deps.config.billing?.prices ?? {}, now), observedAt: new Date(observedAt).toISOString() }, subscriptions };
}

/** Logs a failure: Stripe's operation and code, or the error's name; never an id, an address or a provider message. */
export function logBillingFailure(where: string, e: unknown): void {
  console.error(`${where} failed:`, e instanceof BillingUnavailable ? `${e.operation} (${e.code})` : e instanceof Error ? e.name : "unknown error");
}
