import Stripe from "stripe";
import { describe, expect, it } from "vitest";
import { createFixtureBilling } from "@/lib/test-fixtures/billing";
import { NOW, runGatewayContract } from "./gateway-contract";

const ORIGIN = "http://127.0.0.1:3010";
const WEBHOOK = "whsec_fixture_Zq9x";
const PRICES = { pro: "price_fixture_pro", agency: "price_fixture_agency" };
const make = () => createFixtureBilling({ clock: () => NOW, origin: ORIGIN, webhookSecret: WEBHOOK, prices: { pro: [PRICES.pro], agency: [PRICES.agency] } });
const sessionOf = (url: string) => new URL(url).searchParams.get("session") ?? "";

runGatewayContract("fixtures gateway", () => {
  const gateway = make();
  return {
    gateway,
    origin: ORIGIN,
    webhookSecret: WEBHOOK,
    prices: PRICES,
    pay: (url) => void gateway.complete(sessionOf(url)),
    isOpen: (url) => gateway.session(sessionOf(url))?.status === "open",
    fail: (on) => gateway.fail(on),
    sign: (payload, o = {}) => Stripe.webhooks.generateTestHeaderString({ payload, secret: o.secret ?? WEBHOOK, timestamp: o.atS ?? NOW / 1000 }),
  };
});

describe("fixtures gateway", () => {
  // Fails if the browser test's checkout leaves Retrofit, or a paid or closed checkout can be paid again.
  it("checks out on its own fixture page, once", async () => {
    const g = make();
    const customerId = await g.createCustomer({ accountId: "4f1c2b8e-1d2a-4e55-9c3b-2a1b0c9d8e7f", email: "a@example.test" });
    const url = await g.createCheckout({ accountId: "4f1c2b8e-1d2a-4e55-9c3b-2a1b0c9d8e7f", customerId, priceId: PRICES.pro, attempt: "1", successUrl: `${ORIGIN}/account?checkout=success`, cancelUrl: `${ORIGIN}/pricing?checkout=cancelled` });
    expect(url.startsWith(`${ORIGIN}/test-fixtures/billing/checkout?session=cs_`)).toBe(true);
    expect(g.complete(sessionOf(url))).toBe(`${ORIGIN}/account?checkout=success`);
    expect(g.complete(sessionOf(url))).toBeNull();
    expect(g.complete("cs_unknown")).toBeNull();
  });
});
