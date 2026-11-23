import { afterEach, describe, expect, it, vi } from "vitest";
import { handleCheckout, handlePortal } from "@/lib/api/billing";
import { BILLING_TEXT } from "@/lib/site/billing-texts";
import { accountCookie, captureConsole, OTHER_ACCOUNT, postRequest, PUBLIC_ORIGIN, TEST_ACCOUNT, type TestDeps, type TestDepsOptions } from "../helpers/server-deps";
import { BILLING_ENV, billingDeps, OWNER, PRICES, SECRET_KEY } from "./setup";

afterEach(() => vi.restoreAllMocks());

async function setup(offsetMs = 0, o: TestDepsOptions = {}) {
  const r = billingDeps(offsetMs, o);
  // Signing in created the profiles.
  for (const id of [OWNER, OTHER_ACCOUNT.userId]) await r.d.accounts.ensureProfile(id);
  return { ...r, cookie: await accountCookie(r.d) };
}
const checkout = async (d: TestDeps, cookie: string, body: unknown = { plan: "pro" }, o = {}) => {
  const res = await handleCheckout(postRequest("/api/billing/checkout", body, { cookie, ...o }), d);
  return { status: res.status, body: (await res.json()) as { url?: string; error?: string; message?: string; portal?: boolean } };
};
const portal = async (d: TestDeps, cookie: string, o = {}) => {
  const res = await handlePortal(postRequest("/api/billing/portal", {}, { cookie, ...o }), d);
  return { status: res.status, body: (await res.json()) as { url?: string; error?: string; message?: string } };
};
const sessionOf = (url: string | undefined) => new URL(url ?? "").searchParams.get("session") ?? "";

describe("POST /api/billing/checkout", () => {
  // Fails if the checkout is for another account, price or customer, or returns anywhere but Retrofit's own pages.
  it("opens a checkout for the account's own customer, the plan's price and Retrofit's own pages", async () => {
    const { d, cookie } = await setup();
    const r = await checkout(d, cookie);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ url: expect.stringContaining(`${PUBLIC_ORIGIN}/test-fixtures/billing/checkout?session=`) });
    const record = await d.accounts.getBilling(OWNER);
    expect(record).toMatchObject({ plan: "free", status: "none" });
    expect(d.fixtureBilling.session(sessionOf(r.body.url))).toMatchObject({
      accountId: OWNER,
      customerId: record?.customerId,
      priceId: PRICES.pro,
      successUrl: `${PUBLIC_ORIGIN}/account?checkout=success`,
      cancelUrl: `${PUBLIC_ORIGIN}/pricing?checkout=cancelled`,
    });
    expect((await d.billing.customerOwner(record?.customerId as string))?.accountId).toBe(OWNER);
  });

  // Fails if a plan, price, customer or amount of the request's choosing is used, or an unknown plan opens a checkout.
  it("takes the plan from the fixed table only", async () => {
    const { d, cookie } = await setup();
    for (const body of [{}, { plan: "free" }, { plan: "gold" }, { plan: ["pro"] }, { plan: "constructor" }, "[]"]) expect((await checkout(d, cookie, body)).body.error, JSON.stringify(body)).toBe("invalid");
    expect(d.fixtureBilling.calls).toEqual([]);
    const r = await checkout(d, cookie, { plan: "agency", price: "price_evil", priceId: "price_evil", customer: "cus_evil", amount: 1 });
    expect(d.fixtureBilling.session(sessionOf(r.body.url))).toMatchObject({ priceId: PRICES.agency, customerId: (await d.accounts.getBilling(OWNER))?.customerId });
  });

  // Fails if a signed-out visitor, another site, the time before the start, or a plan without a price reaches Stripe.
  it("refuses another site, a signed-out visitor, 1 ms before the start, and a plan without a price", async () => {
    const { d, cookie } = await setup();
    expect((await checkout(d, cookie, { plan: "pro" }, { fetchSite: "cross-site", origin: "https://evil.example" })).status).toBe(403);
    expect(await checkout(d, "")).toMatchObject({ status: 401, body: { error: "signed_out" } });
    const early = await setup(-1);
    expect(await checkout(early.d, early.cookie)).toEqual({ status: 403, body: { error: "not_started", message: BILLING_TEXT.notStarted } });
    const unpriced = await setup(0, { env: { STRIPE_PRICE_PRO: "" } });
    expect(await checkout(unpriced.d, unpriced.cookie)).toEqual({ status: 409, body: { error: "no_price", message: BILLING_TEXT.noPrice } });
    for (const x of [d, early.d, unpriced.d]) expect(x.fixtureBilling.calls).toEqual([]);
    expect(await early.d.accounts.getBilling(OWNER)).toBeNull();
  });

  // Fails if a double click (also racing) creates two customers or two payable checkouts.
  it("a double click opens one checkout for one customer", async () => {
    const { d, cookie } = await setup();
    const [a, b] = await Promise.all([checkout(d, cookie), checkout(d, cookie)]);
    expect(a.body.url).toBe(b.body.url);
    expect((await checkout(d, cookie)).body.url).toBe(a.body.url);
    const customer = (await d.accounts.getBilling(OWNER))?.customerId;
    const other = await accountCookie(d, OTHER_ACCOUNT);
    await checkout(d, other);
    expect((await d.accounts.getBilling(OTHER_ACCOUNT.userId))?.customerId).not.toBe(customer);
  });

  // P5-R9. Fails if requests of one account (two tabs, two plans, two instances) open checkouts at the same time, so two can be paid.
  it("requests that race, also for two plans, take turns and leave one payable checkout", async () => {
    const { d, cookie } = await setup();
    let open = 0;
    let most = 0;
    const counted: TestDeps = { ...d, billing: { ...d.billing, createCheckout: async (input) => { most = Math.max(most, ++open); await new Promise((r) => setTimeout(r, 5)); try { return await d.billing.createCheckout(input); } finally { open--; } } }, sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))) };
    const results = await Promise.all([checkout(counted, cookie), checkout(counted, cookie, { plan: "agency" }), checkout(counted, cookie), checkout(counted, cookie, { plan: "agency" })]);
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    expect(most).toBe(1);
    expect(new Set(results.map((r) => sessionOf(r.body.url))).size).toBeGreaterThanOrEqual(2);
    expect([...new Set(results.map((r) => sessionOf(r.body.url)))].filter((id) => d.fixtureBilling.session(id)?.status === "open")).toHaveLength(1);
  });

  // Fails if a request that cannot take its turn opens a checkout anyway, or a failed one blocks the next.
  it("answers busy while another request holds the account's turn, and gives the turn back after a failure", async () => {
    const { d, cookie } = await setup();
    const token = await d.store.acquireLease(`billing-checkout:${OWNER}`, 600);
    expect(await checkout(d, cookie)).toEqual({ status: 409, body: { error: "busy", message: BILLING_TEXT.checkoutBusy } });
    expect(d.fixtureBilling.calls).toEqual([]);
    await d.store.releaseLease(`billing-checkout:${OWNER}`, token as string);
    captureConsole([]);
    d.fixtureBilling.fail(true);
    expect((await checkout(d, cookie)).status).toBe(503);
    d.fixtureBilling.fail(false);
    expect((await checkout(d, cookie)).status).toBe(200);
  });

  // P5-R5. Fails if the checkout sells a price that is only kept for its subscribers.
  it("sells the first price of the list", async () => {
    const { d, cookie } = await setup(0, { env: { STRIPE_PRICE_PRO: "price_unit_new,price_unit_pro" } });
    expect(d.fixtureBilling.session(sessionOf((await checkout(d, cookie)).body.url))).toMatchObject({ priceId: "price_unit_new" });
  });

  // Fails if a customer whose subscription is open, also one the webhook has not delivered yet, can buy a second one.
  it("sends an account with an open subscription to the portal, also before the webhook arrives", async () => {
    const { d, cookie } = await setup();
    const { body } = await checkout(d, cookie);
    expect(d.fixtureBilling.complete(sessionOf(body.url))).not.toBeNull();
    const again = await checkout(d, cookie, { plan: "agency" });
    expect(again).toEqual({ status: 409, body: { error: "subscribed", message: BILLING_TEXT.subscribed, portal: true } });
    // What it read from Stripe is stored: the plan is active without a webhook.
    expect(await d.accounts.getBilling(OWNER)).toMatchObject({ plan: "pro", status: "active" });
  });

  // Fails if an ended subscription blocks buying again.
  it("lets an account buy again after its subscription ended", async () => {
    const { d, cookie } = await setup();
    const first = await checkout(d, cookie);
    d.fixtureBilling.complete(sessionOf(first.body.url));
    await d.billing.cancelSubscriptions((await d.accounts.getBilling(OWNER))?.customerId as string);
    const again = await checkout(d, cookie);
    expect(again.status).toBe(200);
    expect(again.body.url).not.toBe(first.body.url);
  });

  // Fails if a URL that is not Stripe's (or the fixtures page outside fixtures mode) is handed to the browser.
  it("never answers a URL that is not Stripe's", async () => {
    const { d, cookie } = await setup();
    const evil: TestDeps = { ...d, billing: { ...d.billing, createCheckout: async () => "https://evil.example/pay", createPortal: async () => `${PUBLIC_ORIGIN}/test-fixtures/clock` } };
    captureConsole([]);
    expect(await checkout(evil, cookie)).toMatchObject({ status: 503, body: { error: "unavailable" } });
    expect(await portal(evil, cookie)).toMatchObject({ status: 503, body: { error: "unavailable" } });
    const production: TestDeps = { ...d, config: { ...d.config, fixturesEnabled: false } };
    expect((await checkout(production, cookie)).status).toBe(503);
  });

  // Fails if checkouts of one account are not limited (each one calls Stripe).
  it("limits the billing actions of an account per hour", async () => {
    const { d, cookie } = await setup();
    let last = 0;
    for (let i = 0; i < 21; i++) last = (await checkout(d, cookie)).status;
    expect(last).toBe(429);
  });

  // Fails if a Stripe outage answers success, leaks an error, or leaves the account unable to try again.
  it("answers unavailable when Stripe is, says nothing about it, and works again later", async () => {
    const lines: string[] = [];
    captureConsole(lines);
    const { d, cookie } = await setup();
    d.fixtureBilling.fail(true);
    const r = await checkout(d, cookie);
    expect(r).toEqual({ status: 503, body: { error: "unavailable", message: BILLING_TEXT.unavailable } });
    expect(lines.join("\n")).toContain("createCustomer");
    for (const secret of [SECRET_KEY, BILLING_ENV.STRIPE_WEBHOOK_SECRET, TEST_ACCOUNT.email, OWNER]) expect(`${lines.join("\n")}${JSON.stringify(r)}`).not.toContain(secret);
    d.fixtureBilling.fail(false);
    expect((await checkout(d, cookie)).status).toBe(200);
  });

  // Fails if a customer that another account already holds is used.
  it("refuses a customer that belongs to another account", async () => {
    captureConsole([]);
    const { d, cookie } = await setup();
    await d.accounts.linkBillingCustomer(OTHER_ACCOUNT.userId, "cus_taken");
    const taken: TestDeps = { ...d, billing: { ...d.billing, createCustomer: async () => "cus_taken" } };
    expect((await checkout(taken, cookie)).status).toBe(503);
    expect(await d.accounts.getBilling(OWNER)).toBeNull();
  });
});

describe("POST /api/billing/portal", () => {
  // Fails if the portal opens for another account's customer, without a customer, signed out or from another site.
  it("opens the portal of the account's own customer only", async () => {
    const { d, cookie } = await setup();
    expect(await portal(d, cookie)).toEqual({ status: 404, body: { error: "no_customer", message: BILLING_TEXT.noCustomer } });
    await checkout(d, cookie);
    const customer = (await d.accounts.getBilling(OWNER))?.customerId;
    expect((await portal(d, cookie)).body.url).toBe(`${PUBLIC_ORIGIN}/test-fixtures/billing/portal?customer=${customer}`);
    expect((await portal(d, await accountCookie(d, OTHER_ACCOUNT))).status).toBe(404);
    expect((await portal(d, "")).status).toBe(401);
    expect((await portal(d, cookie, { fetchSite: "cross-site", origin: "https://evil.example" })).status).toBe(403);
  });
});
