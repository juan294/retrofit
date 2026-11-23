import { describe, expect, it, vi } from "vitest";
import Stripe from "stripe";
import { BillingUnavailable } from "@/lib/billing/gateway";
import { createStripeGateway, STRIPE_API_VERSION } from "@/lib/billing/stripe";
import { captureConsole } from "../helpers/server-deps";
import { createFakeStripe, PERIOD_END_S } from "./fake-stripe";
import { NOW, runGatewayContract } from "./gateway-contract";

const ORIGIN = "https://retrofit.test";
const WEBHOOK = "whsec_contract_Zq9x";
const ACCOUNT = "4f1c2b8e-1d2a-4e55-9c3b-2a1b0c9d8e7f";

function harness() {
  const stripe = createFakeStripe();
  stripe.setPrice("price_pro", { active: true, unit_amount: 1900, currency: "eur", recurring: { interval: "month" } });
  stripe.setPrice("price_off", { active: false, unit_amount: 100, currency: "eur", recurring: { interval: "month" } });
  const gateway = createStripeGateway({ secretKey: "sk_test_contract_Kk77", webhookSecret: WEBHOOK, origin: ORIGIN, fetch: stripe.fetch });
  return { stripe, gateway };
}

runGatewayContract("Stripe adapter over the fake API", () => {
  const { stripe, gateway } = harness();
  return {
    gateway,
    origin: ORIGIN,
    webhookSecret: WEBHOOK,
    prices: { pro: "price_pro", agency: "price_agency" },
    pay: (url) => void stripe.pay(url),
    isOpen: (url) => [...stripe.sessions.values()].some((s) => s.url === url && s.status === "open"),
    fail: (on) => stripe.fail(on ? () => new Error("socket hang up sk_test_contract_Kk77") : null),
    sign: (payload, o = {}) => Stripe.webhooks.generateTestHeaderString({ payload, secret: o.secret ?? WEBHOOK, timestamp: o.atS ?? NOW / 1000 }),
  };
});

describe("Stripe adapter", () => {
  // Fails if a Stripe API version change reaches production without a code change, or telemetry is sent.
  it("pins the API version on every call and sends the key only as the bearer", async () => {
    const { stripe, gateway } = harness();
    await gateway.createCustomer({ accountId: ACCOUNT, email: "a@example.test" });
    expect(STRIPE_API_VERSION).toBe("2026-11-18.endive");
    for (const c of stripe.calls) {
      expect(c.headers.get("stripe-version")).toBe(STRIPE_API_VERSION);
      expect(c.headers.get("authorization")).toBe("Bearer sk_test_contract_Kk77");
      expect(c.headers.get("x-stripe-client-telemetry")).toBeNull();
    }
  });

  // Fails if a checkout is not a subscription for exactly one fixed price, or loses the account, the customer or the URLs.
  it("creates a subscription checkout for the price, the customer and the account", async () => {
    const { stripe, gateway } = harness();
    const customerId = await gateway.createCustomer({ accountId: ACCOUNT, email: "a@example.test" });
    await gateway.createCheckout({ accountId: ACCOUNT, customerId, priceId: "price_pro", successUrl: `${ORIGIN}/account?checkout=success`, cancelUrl: `${ORIGIN}/pricing?checkout=cancelled` });
    const call = stripe.calls.find((c) => c.method === "POST" && c.path === "/v1/checkout/sessions");
    expect(Object.fromEntries(call!.params)).toEqual({
      mode: "subscription",
      customer: customerId,
      client_reference_id: ACCOUNT,
      "line_items[0][price]": "price_pro",
      "line_items[0][quantity]": "1",
      success_url: `${ORIGIN}/account?checkout=success`,
      cancel_url: `${ORIGIN}/pricing?checkout=cancelled`,
      "metadata[retrofit_price]": "price_pro",
    });
    // The SDK's own key for its retries; no key of ours, which would replay a closed checkout.
    expect(call!.headers.get("idempotency-key")).not.toContain(ACCOUNT);
  });

  // Fails if a URL that is not Stripe's reaches the browser.
  it("refuses a checkout or portal URL that is not Stripe's", async () => {
    const { stripe, gateway } = harness();
    const customerId = await gateway.createCustomer({ accountId: ACCOUNT, email: "a@example.test" });
    const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    const evil = { id: "x", object: "checkout.session", status: "open", url: "https://evil.example/", created: 1, metadata: { retrofit_price: "price_pro" } };
    let created = false;
    stripe.fail((c) => {
      if (c.method === "POST") created = true;
      if (c.path === "/v1/checkout/sessions" && c.method === "GET") return reply({ object: "list", data: created ? [evil] : [], has_more: false, url: "/v1/checkout/sessions" });
      return c.method === "POST" || c.path.startsWith("/v1/checkout/sessions/") ? reply(evil) : null;
    });
    await expect(gateway.createPortal({ customerId, returnUrl: ORIGIN })).rejects.toMatchObject({ code: "bad_url" });
    await expect(gateway.createCheckout({ accountId: ACCOUNT, customerId, priceId: "price_pro", successUrl: ORIGIN, cancelUrl: ORIGIN })).rejects.toMatchObject({ code: "bad_url" });
  });

  // Fails if cancelling prorates or invoices (a surprise charge), or a customer deleted in Stripe blocks account deletion,
  // or a customer that this key cannot see (a wrong key) looks cancelled.
  it("cancels at once without an invoice; a deleted customer has nothing to cancel; an unknown one is an error", async () => {
    const { stripe, gateway } = harness();
    const customerId = await gateway.createCustomer({ accountId: ACCOUNT, email: "a@example.test" });
    stripe.subscribe(customerId, "price_pro", "past_due");
    stripe.subscribe(customerId, "price_agency", "incomplete");
    expect(await gateway.cancelSubscriptions(customerId)).toBe(2);
    const deletes = stripe.calls.filter((c) => c.method === "DELETE");
    expect(deletes).toHaveLength(2);
    for (const d of deletes) expect([...d.params.values()]).not.toContain("true");
    expect(await gateway.cancelSubscriptions(customerId)).toBe(0);
    stripe.deleteCustomer(customerId);
    expect(await gateway.cancelSubscriptions(customerId)).toBe(0);
    expect(await gateway.getSubscriptions(customerId)).toEqual([]);
    expect(await gateway.customerOwner(customerId)).toBeNull();
    for (const run of [() => gateway.cancelSubscriptions("cus_elsewhere"), () => gateway.getSubscriptions("cus_elsewhere")]) await expect(run()).rejects.toBeInstanceOf(BillingUnavailable);
    // A customer that exists, but whose subscriptions Stripe calls missing, is an error too.
    const kept = await gateway.createCustomer({ accountId: "5f1c2b8e-1d2a-4e55-9c3b-2a1b0c9d8e7f", email: "b@example.test" });
    stripe.fail((c) => (c.path === "/v1/subscriptions" ? new Response(JSON.stringify({ error: { type: "invalid_request_error", code: "resource_missing" } }), { status: 400, headers: { "content-type": "application/json" } }) : null));
    await expect(gateway.cancelSubscriptions(kept)).rejects.toBeInstanceOf(BillingUnavailable);
  });

  // Fails if a checkout that completes while it is being closed makes the cancellation skip its subscription.
  it("a checkout paid while it was being closed is cancelled too", async () => {
    const { stripe, gateway } = harness();
    const customerId = await gateway.createCustomer({ accountId: ACCOUNT, email: "a@example.test" });
    const url = await gateway.createCheckout({ accountId: ACCOUNT, customerId, priceId: "price_pro", successUrl: ORIGIN, cancelUrl: ORIGIN });
    let paid = false;
    stripe.fail((c) => {
      if (!paid && c.path.endsWith("/expire")) {
        paid = true;
        stripe.pay(url);
      }
      return null;
    });
    await gateway.cancelSubscriptions(customerId);
    expect((await gateway.getSubscriptions(customerId)).map((s) => s.status)).toEqual(["canceled"]);
  });

  // P5-R9. Fails if two requests that race without a lease (an expired one, two instances) leave two payable checkouts.
  it.each([["price_pro", "price_pro"], ["price_pro", "price_agency"]])("two racing checkouts (%s and %s) leave one payable", async (first, second) => {
    const { stripe, gateway } = harness();
    const customerId = await gateway.createCustomer({ accountId: ACCOUNT, email: "a@example.test" });
    const open = (priceId: string) => gateway.createCheckout({ accountId: ACCOUNT, customerId, priceId, successUrl: ORIGIN, cancelUrl: ORIGIN });
    const results = await Promise.allSettled([open(first), open(second)]);
    const payable = [...stripe.sessions.values()].filter((s) => s.status === "open");
    expect(payable).toHaveLength(1);
    expect(results.some((r) => r.status === "fulfilled" && r.value === payable[0]?.url)).toBe(true);
    // Nobody is sent to the checkout of a plan they did not choose.
    results.forEach((r, i) => {
      if (r.status === "fulfilled") expect([...stripe.sessions.values()].find((x) => x.url === r.value)?.params.get("line_items[0][price]")).toBe([first, second][i]);
    });
    // Whoever is refused is told to try again; whoever gets an URL for the same price gets the payable one.
    for (const r of results) if (r.status === "rejected") expect(r.reason).toMatchObject({ code: "superseded" });
    if (first === second) expect(results.map((r) => r.status === "fulfilled" && r.value)).toEqual([payable[0]?.url, payable[0]?.url]);
  });

  // P5-RR2. Fails if a checkout that was paid while it was being replaced is ignored: the customer would pay a second plan.
  it.each([["before the new one exists", false], ["after the new one was created", true]])("a checkout paid %s stops the new checkout and leaves none payable", async (_when, late) => {
    const { stripe, gateway } = harness();
    const customerId = await gateway.createCustomer({ accountId: ACCOUNT, email: "a@example.test" });
    const open = (priceId: string) => gateway.createCheckout({ accountId: ACCOUNT, customerId, priceId, successUrl: ORIGIN, cancelUrl: ORIGIN });
    const first = late ? null : await open("price_pro");
    let lists = 0;
    let paid = false;
    stripe.fail((c) => {
      // Another request's checkout appears between the create and the second list.
      if (late && c.method === "GET" && c.path === "/v1/checkout/sessions" && ++lists === 2) {
        const id = "cs_test_other";
        stripe.sessions.set(id, { id, customer: customerId, status: "open", url: "https://checkout.stripe.com/c/pay/other", created: 0, params: new URLSearchParams({ "metadata[retrofit_price]": "price_pro", "line_items[0][price]": "price_pro" }) });
      }
      if (!paid && c.path.endsWith("/expire")) {
        paid = true;
        stripe.pay(first ?? "https://checkout.stripe.com/c/pay/other");
      }
      return null;
    });
    await expect(open("price_agency")).rejects.toMatchObject({ code: "paid" });
    expect([...stripe.sessions.values()].filter((x) => x.status === "open")).toEqual([]);
    expect((await gateway.getSubscriptions(customerId)).map((x) => x.status)).toEqual(["active"]);
  });

  // P5-RR6. Fails if a checkout of an earlier click comes back closed, or for another plan, when plans alternate.
  it("alternating plans many times always gives an open checkout of the chosen plan, and one at a time", async () => {
    const { stripe, gateway } = harness();
    const customerId = await gateway.createCustomer({ accountId: ACCOUNT, email: "a@example.test" });
    for (let i = 0; i < 40; i++) {
      const priceId = i % 2 ? "price_agency" : "price_pro";
      const url = await gateway.createCheckout({ accountId: ACCOUNT, customerId, priceId, successUrl: ORIGIN, cancelUrl: ORIGIN });
      const open = [...stripe.sessions.values()].filter((x) => x.status === "open");
      expect(open.map((x) => [x.url, x.params.get("line_items[0][price]")])).toEqual([[url, priceId]]);
    }
  });

  // P5-R2. Fails if the period's end is lost, or a cancellation set for another time is taken for the period's end.
  it("reads the period, and a cancellation only when it ends this period", async () => {
    const { stripe, gateway } = harness();
    const customerId = await gateway.createCustomer({ accountId: ACCOUNT, email: "a@example.test" });
    const id = stripe.subscribe(customerId, "price_pro");
    const iso = (s: number) => new Date(s * 1000).toISOString();
    const read = async () => (await gateway.getSubscriptions(customerId))[0];
    expect(await read()).toMatchObject({ currentPeriodEnd: iso(PERIOD_END_S), cancelAtPeriodEnd: false });
    stripe.setSubscription(id, { cancelAt: PERIOD_END_S + 86_400 });
    expect(await read()).toMatchObject({ currentPeriodEnd: iso(PERIOD_END_S), cancelAtPeriodEnd: false });
    stripe.setSubscription(id, { cancelAt: PERIOD_END_S - 86_400 });
    expect(await read()).toMatchObject({ currentPeriodEnd: iso(PERIOD_END_S - 86_400), cancelAtPeriodEnd: true });
    stripe.setSubscription(id, { cancelAt: undefined, cancelAtPeriodEnd: true });
    expect(await read()).toMatchObject({ currentPeriodEnd: iso(PERIOD_END_S), cancelAtPeriodEnd: true });
  });

  // Fails if an inactive price, or one without a fixed amount, shows an amount.
  it("an inactive price and a price without a fixed amount have no amount", async () => {
    const { stripe, gateway } = harness();
    stripe.setPrice("price_tiers", { active: true, unit_amount: null, currency: "eur", recurring: { interval: "month" } });
    expect(await gateway.getPrice("price_off")).toBeNull();
    expect(await gateway.getPrice("price_tiers")).toBeNull();
    expect(await gateway.getPrice("price_pro")).toEqual({ amount: 1900, currency: "eur", interval: "month" });
  });

  // Fails if a Stripe error message (it can quote a key) is logged or thrown on.
  it("an API error is a code only, and nothing is logged", async () => {
    const lines: string[] = [];
    captureConsole(lines);
    const { stripe, gateway } = harness();
    stripe.fail(() => new Response(JSON.stringify({ error: { type: "invalid_request_error", code: "api_key_expired", message: "Expired API Key provided: sk_test_contract_Kk77" } }), { status: 401, headers: { "content-type": "application/json" } }));
    const e = (await gateway.getSubscriptions("cus_1").then(() => null, (x: unknown) => x)) as BillingUnavailable;
    expect(e).toBeInstanceOf(BillingUnavailable);
    expect([e.operation, e.code]).toEqual(["getSubscriptions", "api_key_expired"]);
    expect(`${e.message}${e.stack}${JSON.stringify(e)}${lines.join()}`).not.toContain("Kk77");
    vi.restoreAllMocks();
  });
});
