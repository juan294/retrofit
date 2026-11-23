import type Stripe from "stripe";
import type { BillingEvent, BillingGateway } from "./gateway";
import { BillingUnavailable, WebhookRefused } from "./gateway";
import type { StripeSubscription } from "./state";
import { isBillingUrl } from "./urls";

/**
 * The Stripe adapter (server only, test mode: src/lib/config.ts refuses a live key). The SDK is loaded
 * on the first call, so routes that never bill do not load it. A failure is BillingUnavailable with a
 * code; Stripe's messages are never kept, thrown on or logged.
 */

/** The Stripe API version of every call, whatever the Stripe account's default is. */
export const STRIPE_API_VERSION = "2026-11-18.endive";
/** Seconds an event's signature stays valid (Stripe's default). */
export const WEBHOOK_TOLERANCE_S = 300;
const TIMEOUT_MS = 8_000;
const REPLAY_ATTEMPTS = 3;

export interface StripeGatewayOptions {
  readonly secretKey: string;
  readonly webhookSecret: string;
  /** Retrofit's own origin, kept on each customer. */
  readonly origin: string;
  /** Tests only: replaces the network. */
  readonly fetch?: typeof fetch;
}

const sdk = () => import("stripe").then((m) => m.default);

const codeOf = (e: unknown): string => {
  if (e instanceof BillingUnavailable) return e.code;
  const { code, type } = (e ?? {}) as { code?: unknown; type?: unknown };
  return typeof code === "string" ? code : typeof type === "string" ? type : "request_failed";
};

const idOf = (v: unknown): string | null => {
  const id = typeof v === "object" && v !== null ? (v as { id?: unknown }).id : v;
  return typeof id === "string" ? id : null;
};
const textOf = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** The event of a webhook body signed with `secret` at most WEBHOOK_TOLERANCE_S before `now` (ms). */
export async function verifyStripeEvent(payload: string, signature: string | null, secret: string, now: number): Promise<BillingEvent> {
  const { webhooks } = await sdk();
  let event: unknown;
  try {
    event = webhooks.constructEvent(payload, signature ?? "", secret, WEBHOOK_TOLERANCE_S, undefined, now);
  } catch {
    throw new WebhookRefused();
  }
  const { id, type, livemode, data } = (event ?? {}) as { id?: unknown; type?: unknown; livemode?: unknown; data?: { object?: unknown } };
  const object = data?.object as Record<string, unknown> | null | undefined;
  if (typeof id !== "string" || typeof type !== "string" || typeof livemode !== "boolean" || typeof object !== "object" || object === null) throw new WebhookRefused();
  return { id, type, livemode, customerId: idOf(object.customer), clientReferenceId: textOf(object.client_reference_id), mode: textOf(object.mode) };
}

function subscriptionOf(s: Stripe.Subscription): StripeSubscription {
  // The period is on the items: the subscription's period is its earliest ending item's. A cancellation
  // set for an earlier time ends it there; one set for a later time is not this period's end.
  const item = [...s.items.data].sort((x, y) => x.current_period_end - y.current_period_end)[0];
  const cancelAt = typeof s.cancel_at === "number" ? s.cancel_at : null;
  const end = item && (cancelAt === null ? item.current_period_end : Math.min(item.current_period_end, cancelAt));
  const iso = (seconds: number | undefined) => (seconds === undefined ? null : new Date(seconds * 1000).toISOString());
  return {
    id: s.id,
    status: s.status,
    priceIds: s.items.data.map((i) => i.price.id),
    currentPeriodStart: iso(item?.current_period_start),
    currentPeriodEnd: iso(end),
    cancelAtPeriodEnd: s.cancel_at_period_end || (cancelAt !== null && cancelAt === end),
    created: s.created,
  };
}

export function createStripeGateway(options: StripeGatewayOptions): BillingGateway {
  let client: Promise<Stripe> | undefined;
  const stripe = () =>
    (client ??= sdk().then(
      (S) =>
        new S(options.secretKey, {
          apiVersion: STRIPE_API_VERSION,
          timeout: TIMEOUT_MS,
          maxNetworkRetries: 1,
          telemetry: false,
          ...(options.fetch ? { httpClient: S.createFetchHttpClient(options.fetch) } : {}),
        }),
    ));

  async function call<T>(operation: string, run: (s: Stripe) => Promise<T>): Promise<T> {
    try {
      return await run(await stripe());
    } catch (e) {
      throw new BillingUnavailable(operation, codeOf(e));
    }
  }

  const hosted = (operation: string, url: string | null): string => {
    if (!isBillingUrl(url, null)) throw new BillingUnavailable(operation, "bad_url");
    return url;
  };

  /** Runs `run`; for a customer Stripe says is missing, `gone()` when it was deleted (and not merely unknown to this key). */
  async function forCustomer<T>(s: Stripe, customerId: string, run: () => Promise<T>, gone: () => T): Promise<T> {
    try {
      return await run();
    } catch (e) {
      if (codeOf(e) !== "resource_missing") throw e;
      const customer = await s.customers.retrieve(customerId);
      if (!customer.deleted) throw e;
      return gone();
    }
  }

  async function all<T>(pages: AsyncIterable<T>): Promise<T[]> {
    const items: T[] = [];
    for await (const item of pages) items.push(item);
    return items;
  }

  const openSessions = (s: Stripe, customerId: string) => all(s.checkout.sessions.list({ customer: customerId, status: "open", limit: 100 }));
  const priceOf = (session: Stripe.Checkout.Session) => session.metadata?.retrofit_price ?? null;

  /** Closes a checkout; one that is already paid or closed is left as it is. */
  async function closeSession(s: Stripe, id: string): Promise<void> {
    try {
      await s.checkout.sessions.expire(id);
    } catch (e) {
      if ((await s.checkout.sessions.retrieve(id)).status === "open") throw e;
    }
  }

  /** A new checkout for the key, or the one an equal key already opened; never one that is closed. */
  async function openSession(s: Stripe, params: Stripe.Checkout.SessionCreateParams, key: string): Promise<Stripe.Checkout.Session> {
    for (let attempt = 0; attempt < REPLAY_ATTEMPTS; attempt++) {
      const { id } = await s.checkout.sessions.create(params, { idempotencyKey: key });
      // The answer may be a replay as old as the key's first call: that session may be paid or closed since.
      const session = await s.checkout.sessions.retrieve(id);
      if (session.status === "open") return session;
      key = `retrofit-checkout-after-${id}`;
    }
    throw new BillingUnavailable("createCheckout", "closed");
  }

  return {
    createCustomer({ accountId, email }) {
      return call("createCustomer", async (s) => {
        const customer = await s.customers.create({ email, metadata: { retrofit_account: accountId, retrofit_origin: options.origin } }, { idempotencyKey: `retrofit-customer-${accountId}` });
        return customer.id;
      });
    },

    createCheckout({ accountId, customerId, priceId, attempt, successUrl, cancelUrl }) {
      return call("createCheckout", async (s) => {
        const open = await openSessions(s, customerId);
        const same = open.find((x) => priceOf(x) === priceId && x.url);
        for (const other of open) if (other !== same) await closeSession(s, other.id);
        if (same) return hosted("createCheckout", same.url);
        await openSession(
          s,
          {
            mode: "subscription",
            customer: customerId,
            client_reference_id: accountId,
            line_items: [{ price: priceId, quantity: 1 }],
            success_url: successUrl,
            cancel_url: cancelUrl,
            // Names the checkout's price, so an open one can be reused. Entitlement never reads it.
            metadata: { retrofit_price: priceId },
          },
          `retrofit-checkout-${accountId}-${priceId}-${attempt}`,
        );
        // Another caller may have opened one meanwhile. Every caller that sees the same list keeps the same one:
        // the newest price, and of it the oldest checkout.
        const now = (await openSessions(s, customerId)).sort((x, y) => x.created - y.created || (x.id < y.id ? -1 : 1));
        const newest = now.at(-1);
        const keeper = now.find((x) => newest && priceOf(x) === priceOf(newest));
        for (const other of now) if (other !== keeper) await closeSession(s, other.id);
        if (!keeper || priceOf(keeper) !== priceId) throw new BillingUnavailable("createCheckout", "superseded");
        return hosted("createCheckout", keeper.url);
      });
    },

    createPortal({ customerId, returnUrl }) {
      return call("createPortal", async (s) => hosted("createPortal", (await s.billingPortal.sessions.create({ customer: customerId, return_url: returnUrl })).url));
    },

    getSubscriptions(customerId, o = {}) {
      const request = o.timeoutMs ? { timeout: o.timeoutMs, maxNetworkRetries: 0 } : {};
      return call("getSubscriptions", (s) =>
        forCustomer(s, customerId, async () => (await all(s.subscriptions.list({ customer: customerId, status: "all", limit: 100 }, request))).map(subscriptionOf), () => []),
      );
    },

    customerOwner(customerId) {
      return call("customerOwner", async (s) => {
        const customer = await s.customers.retrieve(customerId);
        if (customer.deleted) return null;
        const { retrofit_account: accountId, retrofit_origin: origin } = customer.metadata;
        return accountId && origin ? { accountId, origin } : null;
      });
    },

    cancelSubscriptions(customerId) {
      return call("cancelSubscriptions", (s) =>
        forCustomer(
          s,
          customerId,
          async () => {
            // First no checkout can be paid any more; one paid in this moment shows as a subscription below.
            for (const session of await openSessions(s, customerId)) await closeSession(s, session.id);
            let cancelled = 0;
            for (const sub of await all(s.subscriptions.list({ customer: customerId, limit: 100 }))) {
              if (sub.status === "canceled" || sub.status === "incomplete_expired") continue;
              try {
                await s.subscriptions.cancel(sub.id);
                cancelled += 1;
              } catch (e) {
                if (codeOf(e) !== "resource_missing") throw e;
              }
            }
            return cancelled;
          },
          () => 0,
        ),
      );
    },

    getPrice(priceId) {
      return call("getPrice", async (s) => {
        try {
          const price = await s.prices.retrieve(priceId);
          if (!price.active || price.unit_amount === null) return null;
          return { amount: price.unit_amount, currency: price.currency, interval: price.recurring?.interval ?? null };
        } catch (e) {
          if (codeOf(e) === "resource_missing") return null;
          throw e;
        }
      });
    },

    verifyWebhook(payload, signature, now) {
      return verifyStripeEvent(payload, signature, options.webhookSecret, now);
    },
  };
}
