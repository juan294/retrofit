import type { Account } from "@/lib/accounts/session";
import type { ServerDeps } from "@/lib/server/runtime";
import { billingStarted } from "./entitlements";
import { BillingUnavailable } from "./gateway";
import type { PaidPlanId } from "./plans";
import { needsPortal } from "./state";
import { readStripe } from "./sync";
import { isBillingUrl } from "./urls";

type Deps = Pick<ServerDeps, "config" | "clock" | "accounts" | "billing">;

/** `not_started`: before BILLING_START. `no_price`: the plan has no price yet. `subscribed`: a subscription is open (the portal changes it). `no_account`: the account was deleted meanwhile. */
export type CheckoutResult = { readonly ok: true; readonly url: string } | { readonly ok: false; readonly code: "not_started" | "no_price" | "subscribed" | "no_account" };

/** Double clicks within this time carry one idempotency key. */
const ATTEMPT_MS = 10 * 60_000;

/** A hosted page's URL, or BillingUnavailable for anything else (urls.ts). */
export function requireBillingUrl(deps: Pick<Deps, "config">, operation: string, url: string): string {
  if (!isBillingUrl(url, fixtureOriginOf(deps.config))) throw new BillingUnavailable(operation, "bad_url");
  return url;
}

/** The origin whose fixture pages may be navigated to: fixtures mode only, else null. */
export const fixtureOriginOf = (config: Pick<ServerDeps["config"], "fixturesEnabled" | "publicOrigin">): string | null => (config.fixturesEnabled ? config.publicOrigin : null);

/** The refusals that need no Stripe call and no read. */
export function checkoutPrice(deps: Pick<Deps, "config" | "clock">, plan: PaidPlanId): { readonly priceId: string } | { readonly code: "not_started" | "no_price" } {
  if (!billingStarted(deps)) return { code: "not_started" };
  const priceId = deps.config.billing?.prices[plan];
  return priceId ? { priceId } : { code: "no_price" };
}

/**
 * A hosted subscription checkout for the account (phase-5.md). The account has one Stripe customer: the
 * stored one, or one created and bound now, before the checkout exists, so every later event finds its
 * account. An account with an open subscription is refused after asking Stripe, also before its webhook
 * arrives. Throws when Stripe or the account data is unavailable.
 */
export async function startCheckout(deps: Deps, account: Pick<Account, "accountId" | "email">, plan: PaidPlanId): Promise<CheckoutResult> {
  const price = checkoutPrice(deps, plan);
  if ("code" in price) return { ok: false, code: price.code };

  let customerId = (await deps.accounts.getBilling(account.accountId))?.customerId;
  if (!customerId) {
    const linked = await deps.accounts.linkBillingCustomer(account.accountId, await deps.billing.createCustomer({ accountId: account.accountId, email: account.email }));
    if ("billing" in linked) customerId = linked.billing.customerId;
    else if (linked.outcome === "no_account") return { ok: false, code: "no_account" };
    else throw new BillingUnavailable("createCheckout", "customer_taken");
  }
  const { observed, subscriptions } = await readStripe(deps, customerId);
  await deps.accounts.applyBillingState(customerId, observed);
  if (needsPortal(subscriptions)) return { ok: false, code: "subscribed" };

  const { publicOrigin } = deps.config;
  const url = await deps.billing.createCheckout({
    accountId: account.accountId,
    customerId,
    priceId: price.priceId,
    attempt: `${observed.subscriptionId ?? "first"}-${Math.floor(deps.clock() / ATTEMPT_MS)}`,
    successUrl: `${publicOrigin}/account?checkout=success`,
    cancelUrl: `${publicOrigin}/pricing?checkout=cancelled`,
  });
  return { ok: true, url: requireBillingUrl(deps, "createCheckout", url) };
}
