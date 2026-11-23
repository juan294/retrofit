import type { BillingRecord } from "@/lib/accounts/data";
import type { Account } from "@/lib/accounts/session";
import { realSleep } from "@/lib/fetch/timers";
import type { ServerDeps } from "@/lib/server/runtime";
import { billingStarted } from "./entitlements";
import { BillingUnavailable } from "./gateway";
import type { PaidPlanId } from "./plans";
import { needsPortal } from "./state";
import { readStripe } from "./sync";
import { isBillingUrl } from "./urls";

type Deps = Pick<ServerDeps, "config" | "clock" | "store" | "accounts" | "billing" | "sleep">;

/** `not_started`: before BILLING_START. `no_price`: the plan has no price yet. `subscribed`: a subscription is open (the portal changes it). `no_account`: the account was deleted meanwhile. `busy`: another checkout of the account is being opened. */
export type CheckoutResult = { readonly ok: true; readonly url: string } | { readonly ok: false; readonly code: "not_started" | "no_price" | "subscribed" | "no_account" | "busy" };

/** One checkout of an account is opened at a time; a second request waits this long for the first. */
const LEASE_S = 60;
const LEASE_WAITS = 50;
const LEASE_WAIT_MS = 100;

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
  const priceId = deps.config.billing?.prices[plan]?.[0];
  return priceId ? { priceId } : { code: "no_price" };
}

/**
 * A hosted subscription checkout for the account (phase-5.md). The account has one Stripe customer: the
 * stored one, or one created and bound now, before the checkout exists, so every later event finds its
 * account. An account with an open subscription is refused after asking Stripe, also before its webhook
 * arrives. A Store lease per account makes its requests take turns, so a customer has one payable
 * checkout. Throws when Stripe or the account data is unavailable.
 */
export async function startCheckout(deps: Deps, account: Pick<Account, "accountId" | "email">, plan: PaidPlanId): Promise<CheckoutResult> {
  const price = checkoutPrice(deps, plan);
  if ("code" in price) return { ok: false, code: price.code };

  const leaseKey = `billing-checkout:${account.accountId}`;
  const token = await waitForLease(deps, leaseKey);
  if (token === null) return { ok: false, code: "busy" };
  try {
    return await openCheckout(deps, account, price.priceId);
  } finally {
    await deps.store.releaseLease(leaseKey, token);
  }
}

async function waitForLease(deps: Pick<Deps, "store" | "sleep">, key: string): Promise<string | null> {
  for (let i = 0; ; i++) {
    const token = await deps.store.acquireLease(key, LEASE_S);
    if (token !== null || i >= LEASE_WAITS) return token;
    await (deps.sleep ?? realSleep)(LEASE_WAIT_MS);
  }
}

async function openCheckout(deps: Deps, account: Pick<Account, "accountId" | "email">, priceId: string): Promise<CheckoutResult> {
  let record = await deps.accounts.getBilling(account.accountId);
  if (!record) {
    const linked = await deps.accounts.linkBillingCustomer(account.accountId, await deps.billing.createCustomer({ accountId: account.accountId, email: account.email }));
    if ("billing" in linked) record = linked.billing;
    else if (linked.outcome === "no_account") return { ok: false, code: "no_account" };
    else throw new BillingUnavailable("createCheckout", "customer_taken");
  }
  if (await subscribed(deps, record)) return { ok: false, code: "subscribed" };

  const { publicOrigin } = deps.config;
  try {
    const url = await deps.billing.createCheckout({
      accountId: account.accountId,
      customerId: record.customerId,
      priceId,
      successUrl: `${publicOrigin}/account?checkout=success`,
      cancelUrl: `${publicOrigin}/pricing?checkout=cancelled`,
    });
    return { ok: true, url: requireBillingUrl(deps, "createCheckout", url) };
  } catch (e) {
    // An earlier checkout was paid while this one was being opened: the plan is bought. Until Stripe shows it, try again.
    if (!(e instanceof BillingUnavailable) || e.code !== "paid") throw e;
    const now = (await deps.accounts.getBilling(account.accountId)) ?? record;
    if (await subscribed(deps, now)) return { ok: false, code: "subscribed" };
    throw e;
  }
}

/** True when Stripe shows a subscription that is still open. What it says is stored. */
async function subscribed(deps: Deps, record: BillingRecord): Promise<boolean> {
  const { observed, subscriptions } = await readStripe(deps, record);
  await deps.accounts.applyBillingState(record.customerId, observed);
  return needsPortal(subscriptions);
}
