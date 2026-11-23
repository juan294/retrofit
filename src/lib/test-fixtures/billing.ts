import { BillingUnavailable, type BillingGateway, type CheckoutInput } from "@/lib/billing/gateway";
import type { PaidPlanId } from "@/lib/billing/plans";
import type { StripeSubscription } from "@/lib/billing/state";
import { verifyStripeEvent } from "@/lib/billing/stripe";
import { FIXTURE_BILLING_PATH } from "@/lib/billing/urls";
import type { Clock } from "@/lib/store/types";

/**
 * Fixtures mode and unit tests only: an in-memory stand-in for Stripe with the same observable rules as
 * the adapter (tests/billing/gateway-contract.ts). Its checkout is a page on Retrofit's own origin
 * (/test-fixtures/billing/checkout) that pays or cancels and redirects back. Webhook signatures are
 * checked as in production, with the configured test secret. Production never builds it
 * (src/lib/server/runtime.ts uses it only when RETROFIT_TEST_FIXTURES is set, which loadConfig refuses on Vercel).
 */

const MONTH_MS = 30 * 24 * 3600 * 1000;
/** Test amounts, in cents. They are not Retrofit's prices. */
const AMOUNTS: Readonly<Record<PaidPlanId, number>> = { pro: 1100, agency: 2200 };

export interface FixtureSession extends CheckoutInput {
  readonly id: string;
  status: "open" | "complete" | "expired";
}

export interface FixtureBilling extends BillingGateway {
  /** Every call, in order (operation names only). */
  readonly calls: readonly string[];
  session(id: string): FixtureSession | null;
  /** Pays an open checkout: an active subscription for its price. Returns its success URL, or null when it is not open. */
  complete(id: string): string | null;
  /** A subscription of the customer, for states a checkout cannot make. */
  subscribe(customerId: string, o: Partial<StripeSubscription>): StripeSubscription;
  /** Changes a stored subscription (a renewal, a failed payment, a cancellation at Stripe). */
  update(subscriptionId: string, change: Partial<StripeSubscription>): void;
  /** Makes every later call (or only those of `operation`) fail; false heals. */
  fail(on: boolean, operation?: keyof BillingGateway): void;
  /** Runs before each call of `operation`: tests change state in the middle of a flow. */
  before(operation: keyof BillingGateway, hook: (() => void | Promise<void>) | null): void;
}

export function createFixtureBilling(options: { clock: Clock; origin: string; webhookSecret: string; prices: Readonly<Partial<Record<PaidPlanId, string>>> }): FixtureBilling {
  const customers = new Map<string, { readonly accountId: string; readonly email: string }>();
  const sessions = new Map<string, FixtureSession>();
  const subscriptions = new Map<string, StripeSubscription & { readonly customerId: string }>();
  const hooks = new Map<keyof BillingGateway, () => void | Promise<void>>();
  const calls: string[] = [];
  let failing: "all" | keyof BillingGateway | null = null;
  let n = 0;

  async function enter(operation: keyof BillingGateway): Promise<void> {
    calls.push(operation);
    await hooks.get(operation)?.();
    if (failing === "all" || failing === operation) throw new BillingUnavailable(operation, "fixture_failure");
  }
  const openOf = (customerId: string) => [...sessions.values()].filter((s) => s.customerId === customerId && s.status === "open");

  return {
    calls,
    async createCustomer({ accountId, email }) {
      await enter("createCustomer");
      const existing = [...customers].find(([, c]) => c.accountId === accountId);
      if (existing) return existing[0];
      const id = `cus_fixture${++n}`;
      customers.set(id, { accountId, email });
      return id;
    },
    async createCheckout(input) {
      await enter("createCheckout");
      const open = openOf(input.customerId);
      let session = open.find((s) => s.priceId === input.priceId);
      for (const s of open) if (s !== session) s.status = "expired";
      if (!session) {
        session = { ...input, id: `cs_fixture${++n}`, status: "open" };
        sessions.set(session.id, session);
      }
      return `${options.origin}${FIXTURE_BILLING_PATH}checkout?session=${session.id}`;
    },
    async createPortal({ customerId }) {
      await enter("createPortal");
      return `${options.origin}${FIXTURE_BILLING_PATH}portal?customer=${customerId}`;
    },
    async getSubscriptions(customerId) {
      await enter("getSubscriptions");
      return [...subscriptions.values()].filter((s) => s.customerId === customerId).map(({ customerId: _, ...s }) => s);
    },
    async customerOwner(customerId) {
      await enter("customerOwner");
      const c = customers.get(customerId);
      return c ? { accountId: c.accountId, origin: options.origin } : null;
    },
    async cancelSubscriptions(customerId) {
      await enter("cancelSubscriptions");
      for (const s of openOf(customerId)) s.status = "expired";
      for (const [id, s] of subscriptions) if (s.customerId === customerId) subscriptions.set(id, { ...s, status: "canceled" });
    },
    async getPrice(priceId) {
      await enter("getPrice");
      const plan = (Object.keys(options.prices) as PaidPlanId[]).find((p) => options.prices[p] === priceId);
      return plan ? { amount: AMOUNTS[plan], currency: "usd", interval: "month" } : null;
    },
    async verifyWebhook(payload, signature, now) {
      return verifyStripeEvent(payload, signature, options.webhookSecret, now);
    },
    session: (id) => sessions.get(id) ?? null,
    complete(id) {
      const session = sessions.get(id);
      if (!session || session.status !== "open") return null;
      session.status = "complete";
      this.subscribe(session.customerId, { priceIds: [session.priceId] });
      return session.successUrl;
    },
    subscribe(customerId, o) {
      const now = options.clock();
      const sub: StripeSubscription = {
        id: `sub_fixture${++n}`,
        status: "active",
        priceIds: [],
        currentPeriodEnd: new Date(now + MONTH_MS).toISOString(),
        cancelAtPeriodEnd: false,
        created: Math.floor(now / 1000) + n,
        ...o,
      };
      subscriptions.set(sub.id, { ...sub, customerId });
      return sub;
    },
    update(id, change) {
      const s = subscriptions.get(id);
      if (s) subscriptions.set(id, { ...s, ...change });
    },
    fail(on, operation) {
      failing = on ? (operation ?? "all") : null;
    },
    before(operation, hook) {
      if (hook) hooks.set(operation, hook);
      else hooks.delete(operation);
    },
  };
}
