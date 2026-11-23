import type { StripeSubscription } from "./state";

/**
 * BillingGateway: everything Retrofit asks of Stripe, behind one interface. Server only. The Stripe
 * adapter is stripe.ts; fixtures mode and unit tests use src/lib/test-fixtures/billing.ts; both keep
 * tests/billing/gateway-contract.ts. Card data never reaches Retrofit (hosted Checkout and portal).
 */
export interface BillingGateway {
  /** The account's Stripe customer, carrying the account id and Retrofit's origin. A repeat (a double click) answers the same one. */
  createCustomer(input: { readonly accountId: string; readonly email: string }): Promise<string>;
  /**
   * The URL of the customer's one open subscription checkout for the price: an open one for the same
   * price is reused, one for another price is closed first. After creating one it looks again, so that also
   * callers that race leave one payable checkout.
   */
  createCheckout(input: CheckoutInput): Promise<string>;
  /** The URL of a customer portal session (change the card, switch the plan, cancel). */
  createPortal(input: { readonly customerId: string; readonly returnUrl: string }): Promise<string>;
  /** Every subscription of the customer, also ended ones. None for a customer deleted in Stripe. */
  getSubscriptions(customerId: string, options?: { readonly timeoutMs?: number }): Promise<readonly StripeSubscription[]>;
  /** The account and Retrofit origin the customer was created for, or null (another product's, or deleted). */
  customerOwner(customerId: string): Promise<CustomerOwner | null>;
  /** Closes the customer's open checkouts and cancels every subscription now, without a new invoice. Returns how many it cancelled. Safe to repeat. */
  cancelSubscriptions(customerId: string): Promise<number>;
  /** The fixed amount of an active price, or null (unknown, inactive, or no fixed amount). */
  getPrice(priceId: string): Promise<PriceAmount | null>;
  /** The event of a signed webhook body at `now` (ms). Throws WebhookRefused for anything else. */
  verifyWebhook(payload: string, signature: string | null, now: number): Promise<BillingEvent>;
}

export interface CheckoutInput {
  readonly accountId: string;
  readonly customerId: string;
  readonly priceId: string;
  /** Part of the idempotency key: equal for a double click, different once the subscription changed. */
  readonly attempt: string;
  readonly successUrl: string;
  readonly cancelUrl: string;
}

export interface CustomerOwner {
  readonly accountId: string;
  readonly origin: string;
}

export interface PriceAmount {
  /** In the currency's smallest unit. */
  readonly amount: number;
  /** ISO 4217, lower case. */
  readonly currency: string;
  /** Stripe's billing interval (month, year), or null. */
  readonly interval: string | null;
}

/** What Retrofit reads of a webhook event. The subscription itself is always read again from Stripe. */
export interface BillingEvent {
  readonly id: string;
  readonly type: string;
  readonly livemode: boolean;
  readonly customerId: string | null;
  readonly clientReferenceId: string | null;
  /** A checkout session's mode, else null. */
  readonly mode: string | null;
}

/** A failed gateway call: an operation and a code, never a provider message (it can quote a key). */
export class BillingUnavailable extends Error {
  constructor(
    public readonly operation: string,
    public readonly code: string,
  ) {
    super(`billing ${operation} failed (${code})`);
    this.name = "BillingUnavailable";
  }
}

/** A webhook body without a valid, recent signature. No reason is kept: Stripe's message names part of the secret. */
export class WebhookRefused extends Error {
  constructor() {
    super("webhook refused");
    this.name = "WebhookRefused";
  }
}

/** Without Stripe configuration (local development): every call answers unavailable. */
export function unavailableBillingGateway(): BillingGateway {
  const refuse = (operation: string) => async () => {
    throw new BillingUnavailable(operation, "not_configured");
  };
  return {
    createCustomer: refuse("createCustomer"),
    createCheckout: refuse("createCheckout"),
    createPortal: refuse("createPortal"),
    getSubscriptions: refuse("getSubscriptions"),
    customerOwner: refuse("customerOwner"),
    cancelSubscriptions: refuse("cancelSubscriptions"),
    getPrice: refuse("getPrice"),
    verifyWebhook: refuse("verifyWebhook"),
  };
}
