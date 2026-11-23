/**
 * Shared BillingGateway contract: the real adapter over the fake Stripe API (tests/billing/stripe.test.ts)
 * and the fixtures gateway (tests/billing/fixture-gateway.test.ts).
 */
import { describe, expect, it } from "vitest";
import type { BillingGateway, CheckoutInput } from "@/lib/billing/gateway";
import { BillingUnavailable, WebhookRefused } from "@/lib/billing/gateway";

export interface GatewayHarness {
  readonly gateway: BillingGateway;
  readonly origin: string;
  readonly webhookSecret: string;
  readonly prices: { readonly pro: string; readonly agency: string };
  /** Pays the checkout at `url`. */
  pay(url: string): void;
  isOpen(url: string): boolean;
  /** Every later call fails until healed. */
  fail(on: boolean): void;
  sign(payload: string, o?: { secret?: string; atS?: number }): string;
}

const ACCOUNT = "4f1c2b8e-1d2a-4e55-9c3b-2a1b0c9d8e7f";
const OTHER = "5f1c2b8e-1d2a-4e55-9c3b-2a1b0c9d8e7f";
export const NOW = Date.parse("2027-02-01T10:00:00.000Z");

export function runGatewayContract(name: string, make: () => GatewayHarness): void {
  describe(`BillingGateway contract: ${name}`, () => {
    const customerOf = (h: GatewayHarness, accountId = ACCOUNT) => h.gateway.createCustomer({ accountId, email: `${accountId.slice(0, 4)}@example.test` });
    const checkout = (h: GatewayHarness, customerId: string, o: Partial<CheckoutInput> = {}) =>
      h.gateway.createCheckout({ accountId: ACCOUNT, customerId, priceId: h.prices.pro, successUrl: `${h.origin}/account?checkout=success`, cancelUrl: `${h.origin}/pricing?checkout=cancelled`, ...o });

    // Fails if a double click creates two customers, two accounts share one, or the customer's owner is lost.
    it("creates one customer per account, also when two calls race, and names its owner", async () => {
      const h = make();
      const [first, second] = await Promise.all([customerOf(h), customerOf(h)]);
      expect(first).toMatch(/^cus_\w+$/);
      expect(second).toBe(first);
      expect(await customerOf(h, OTHER)).not.toBe(first);
      expect(await h.gateway.customerOwner(first)).toEqual({ accountId: ACCOUNT, origin: h.origin });
    });

    // Fails if a double click (also racing) opens two checkouts, or a second plan leaves the first checkout payable (two subscriptions).
    it("keeps one open checkout per customer: a repeat reuses it, another plan replaces it", async () => {
      const h = make();
      const customer = await customerOf(h);
      const [a, b] = await Promise.all([checkout(h, customer), checkout(h, customer)]);
      expect(b).toBe(a);
      expect(await checkout(h, customer)).toBe(a);
      const agency = await checkout(h, customer, { priceId: h.prices.agency });
      expect(agency).not.toBe(a);
      expect(h.isOpen(a)).toBe(false);
      expect(h.isOpen(agency)).toBe(true);
      // Back to the first plan: a new open checkout, never the expired one.
      const again = await checkout(h, customer);
      expect(again).not.toBe(a);
      expect(h.isOpen(again)).toBe(true);
      expect(h.isOpen(agency)).toBe(false);
    });

    // Fails if a paid checkout is not seen as an active subscription with its price and period end.
    it("reads a customer's subscriptions with status, prices and period end", async () => {
      const h = make();
      const customer = await customerOf(h);
      expect(await h.gateway.getSubscriptions(customer)).toEqual([]);
      h.pay(await checkout(h, customer));
      const [sub, ...rest] = await h.gateway.getSubscriptions(customer);
      expect(rest).toEqual([]);
      expect(sub).toMatchObject({ id: expect.stringMatching(/^sub_\w+$/), status: "active", priceIds: [h.prices.pro], cancelAtPeriodEnd: false });
      expect(Date.parse(sub?.currentPeriodEnd as string)).toBeGreaterThan(NOW);
      expect(sub?.created).toEqual(expect.any(Number));
    });

    // Fails if a subscription or an open checkout survives the cancellation, or a retry fails.
    it("cancels every subscription at once and closes open checkouts; a retry succeeds", async () => {
      const h = make();
      const customer = await customerOf(h);
      h.pay(await checkout(h, customer));
      const open = await checkout(h, customer, { priceId: h.prices.agency });
      expect(await h.gateway.cancelSubscriptions(customer)).toBe(1);
      expect((await h.gateway.getSubscriptions(customer)).map((s) => s.status)).toEqual(["canceled"]);
      expect(h.isOpen(open)).toBe(false);
      expect(await h.gateway.cancelSubscriptions(customer)).toBe(0);
    });

    it("gives a portal link and a price's amount; an unknown price has none", async () => {
      const h = make();
      const customer = await customerOf(h);
      expect(new URL(await h.gateway.createPortal({ customerId: customer, returnUrl: `${h.origin}/account` })).protocol).toMatch(/^https?:$/);
      expect(await h.gateway.getPrice(h.prices.pro)).toEqual({ amount: expect.any(Number), currency: expect.stringMatching(/^[a-z]{3}$/), interval: "month" });
      expect(await h.gateway.getPrice("price_unknown")).toBeNull();
    });

    // Fails if an outage looks like an empty answer (a paying customer would become free) or leaks anything but a code.
    it("an outage throws BillingUnavailable with an operation and a code only", async () => {
      const h = make();
      const customer = await customerOf(h);
      h.fail(true);
      for (const run of [() => customerOf(h, OTHER), () => checkout(h, customer), () => h.gateway.createPortal({ customerId: customer, returnUrl: h.origin }), () => h.gateway.getSubscriptions(customer), () => h.gateway.customerOwner(customer), () => h.gateway.cancelSubscriptions(customer), () => h.gateway.getPrice(h.prices.pro)]) {
        const e = await run().then(() => null, (x: unknown) => x);
        expect(e).toBeInstanceOf(BillingUnavailable);
        expect(`${(e as Error).message} ${(e as Error).stack}`).not.toMatch(/sk_test|whsec|example\.test/);
      }
      h.fail(false);
      expect(await h.gateway.getSubscriptions(customer)).toEqual([]);
    });

    describe("webhook signatures", () => {
      const payload = (o: Record<string, unknown> = {}) => JSON.stringify({ id: "evt_1", object: "event", type: "checkout.session.completed", livemode: false, data: { object: { object: "checkout.session", customer: "cus_1", client_reference_id: ACCOUNT, mode: "subscription" } }, ...o });

      // Fails if a signed event is refused or its fields are read wrongly.
      it("verifies a signed event and reads its customer, reference and mode", async () => {
        const h = make();
        const body = payload();
        expect(await h.gateway.verifyWebhook(body, h.sign(body), NOW)).toEqual({ id: "evt_1", type: "checkout.session.completed", livemode: false, customerId: "cus_1", clientReferenceId: ACCOUNT, mode: "subscription" });
        const expanded = payload({ type: "customer.subscription.updated", livemode: true, data: { object: { object: "subscription", id: "sub_1", customer: { id: "cus_2" } } } });
        expect(await h.gateway.verifyWebhook(expanded, h.sign(expanded), NOW)).toEqual({ id: "evt_1", type: "customer.subscription.updated", livemode: true, customerId: "cus_2", clientReferenceId: null, mode: null });
      });

      // Fails if a forged, changed, old or unsigned event is accepted, or the refusal says anything about the secret.
      it("refuses a wrong secret, a changed body, an old signature, a missing header and a body that is not an event", async () => {
        const h = make();
        const body = payload();
        const cases: [string, string | null][] = [
          [body, h.sign(body, { secret: "whsec_other" })],
          [body.replace("evt_1", "evt_2"), h.sign(body)],
          [body, h.sign(body, { atS: NOW / 1000 - 301 })],
          [body, null],
          [body, ""],
          [body, "t=1,v1=00"],
          // Stripe's message for this header names the length and the last characters of the secret.
          [body, `t=${NOW / 1000},v1=00,secret=whsec_****0000`],
          ["not json", h.sign("not json")],
          ["{}", h.sign("{}")],
          ["null", h.sign("null")],
        ];
        for (const [b, sig] of cases) {
          const e = await h.gateway.verifyWebhook(b, sig, NOW).then(() => null, (x: unknown) => x);
          expect(e, `${b.slice(0, 20)} ${sig}`).toBeInstanceOf(WebhookRefused);
          expect(`${(e as Error).message} ${(e as Error).stack} ${String((e as Error).cause ?? "")}`).not.toContain(h.webhookSecret.slice(-4));
        }
        expect((await h.gateway.verifyWebhook(body, h.sign(body, { atS: NOW / 1000 - 300 }), NOW)).id).toBe("evt_1");
      });
    });
  });
}
