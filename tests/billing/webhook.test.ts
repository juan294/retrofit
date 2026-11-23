import Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryAccountData } from "@/lib/accounts/memory";
import { deleteAccount } from "@/lib/accounts/delete";
import { createAccountSession, readAccountByToken } from "@/lib/accounts/session";
import { handleCheckout } from "@/lib/api/billing";
import { handleBillingWebhook, MAX_WEBHOOK_BYTES } from "@/lib/api/billing-webhook";
import { captureConsole, OTHER_ACCOUNT, postRequest, PUBLIC_ORIGIN, TEST_ACCOUNT, testDeps, type TestDeps, type TestDepsOptions } from "../helpers/server-deps";
import { billingDeps, brokenBilling, OWNER, PRICES, SECRET_KEY, WEBHOOK_SECRET } from "./setup";

const lines: string[] = [];
beforeEach(() => {
  lines.length = 0;
  captureConsole(lines);
});
afterEach(() => vi.restoreAllMocks());

const UPDATED = "customer.subscription.updated";
const DELETED = "customer.subscription.deleted";
const COMPLETED = "checkout.session.completed";
let n = 0;

interface EventSpec {
  id?: string;
  type?: string;
  livemode?: boolean;
  customer?: unknown;
  ref?: string | null;
  mode?: string;
}

function eventBody(e: EventSpec): string {
  const object = e.type === COMPLETED ? { object: "checkout.session", customer: e.customer, client_reference_id: e.ref ?? null, mode: e.mode ?? "subscription" } : { object: "subscription", id: "sub_x", customer: e.customer, status: "active" };
  return JSON.stringify({ id: e.id ?? `evt_unit${++n}`, object: "event", type: e.type ?? UPDATED, livemode: e.livemode ?? false, created: 1, data: { object } });
}
function send(d: TestDeps, body: string, o: { signature?: string | null; secret?: string; headers?: Record<string, string> } = {}): Promise<Response> {
  const signature = o.signature === undefined ? Stripe.webhooks.generateTestHeaderString({ payload: body, secret: o.secret ?? WEBHOOK_SECRET, timestamp: Math.floor(d.clock() / 1000) }) : o.signature;
  return handleBillingWebhook(new Request(`${PUBLIC_ORIGIN}/api/billing/webhook`, { method: "POST", body, headers: { "content-type": "application/json", ...(signature ? { "stripe-signature": signature } : {}), ...o.headers } }), d);
}
const deliver = (d: TestDeps, e: EventSpec) => send(d, eventBody(e));

/** A customer linked to OWNER and created at the gateway for it. */
async function customer(d: TestDeps): Promise<string> {
  const id = await d.billing.createCustomer({ accountId: OWNER, email: TEST_ACCOUNT.email });
  await d.accounts.linkBillingCustomer(OWNER, id);
  return id;
}
async function setup(o: TestDepsOptions = {}) {
  const r = billingDeps(0, o);
  return { ...r, cus: await customer(r.d) };
}
const planOf = async (d: TestDeps) => (await d.accounts.getBilling(OWNER))?.plan;

describe("webhook signatures and bodies", () => {
  // Fails if a forged, unsigned, changed or old event is applied or recorded, or the answer names the secret.
  it("refuses a bad signature with 400 and applies nothing", async () => {
    const { d, cus, clock } = await setup();
    d.fixtureBilling.subscribe(cus, { priceIds: [PRICES.pro] });
    const body = eventBody({ customer: cus });
    const old = Stripe.webhooks.generateTestHeaderString({ payload: body, secret: WEBHOOK_SECRET, timestamp: Math.floor(d.clock() / 1000) });
    for (const res of [await send(d, body, { secret: "whsec_other" }), await send(d, body, { signature: null }), await send(d, body, { signature: "t=1,v1=00,secret=whsec_****0000" }), await send(d, body.replace(cus, "cus_evil"), { signature: old })]) {
      expect(res.status).toBe(400);
      expect(await res.text()).toBe('{"error":"bad_signature"}');
    }
    clock.advance(301_000);
    expect((await send(d, body, { signature: old })).status).toBe(400);
    expect(await planOf(d)).toBe("free");
    expect(d.accountsBacking.stripeEvents.size).toBe(0);
    for (const s of [WEBHOOK_SECRET, WEBHOOK_SECRET.slice(-4), SECRET_KEY]) expect(lines.join("\n")).not.toContain(s);
  });

  // Fails if a huge body is read whole, whatever its declared length.
  it("refuses a body over the limit with 413 before reading it all", async () => {
    const { d } = await setup();
    expect((await send(d, "x".repeat(MAX_WEBHOOK_BYTES + 1), { signature: "t=1,v1=00" })).status).toBe(413);
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled++;
        c.enqueue(new Uint8Array(64 * 1024));
      },
    });
    const req = new Request(`${PUBLIC_ORIGIN}/api/billing/webhook`, { method: "POST", body: endless, duplex: "half" } as RequestInit);
    expect((await handleBillingWebhook(req, d)).status).toBe(413);
    expect(pulled).toBeLessThan(MAX_WEBHOOK_BYTES / (64 * 1024) + 4);
  });

  // Fails if a live-mode event is accepted while Retrofit is in test mode.
  it("refuses a live-mode event with 400", async () => {
    const { d, cus } = await setup();
    d.fixtureBilling.subscribe(cus, { priceIds: [PRICES.pro] });
    for (const type of [UPDATED, "invoice.paid"]) {
      const res = await deliver(d, { customer: cus, livemode: true, type });
      expect([res.status, await res.json()]).toEqual([400, { error: "live_mode" }]);
    }
    expect(await planOf(d)).toBe("free");
    expect(d.accountsBacking.stripeEvents.size).toBe(0);
  });

  // Fails if the webhook needs a cookie or the page's origin, or sets a cookie.
  it("needs no cookie and no same-origin request, and sets none", async () => {
    const { d, cus } = await setup();
    const res = await send(d, eventBody({ customer: cus }), { headers: { origin: "https://stripe.example", "sec-fetch-site": "cross-site" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(await res.json()).toEqual({ received: true });
  });

  it("answers 503 without Stripe configuration", async () => {
    expect((await handleBillingWebhook(new Request(`${PUBLIC_ORIGIN}/api/billing/webhook`, { method: "POST", body: "{}" }), testDeps())).status).toBe(503);
  });
});

describe("events", () => {
  // Fails if an event type does not bring Stripe's state to the account, or the state comes from the event's own body.
  it.each([COMPLETED, UPDATED, DELETED])("%s stores what Stripe says now", async (type) => {
    const { d, cus, clock } = await setup();
    const sub = d.fixtureBilling.subscribe(cus, { priceIds: [PRICES.agency] });
    expect((await deliver(d, { type, customer: cus, ref: OWNER })).status).toBe(200);
    expect(await d.accounts.getBilling(OWNER)).toMatchObject({ plan: "agency", status: "active", subscriptionId: sub.id, currentPeriodEnd: sub.currentPeriodEnd, stateAt: new Date(clock.now()).toISOString() });
    d.fixtureBilling.update(sub.id, { status: "canceled" });
    clock.advance(1000);
    await deliver(d, { type, customer: cus, ref: OWNER });
    expect(await d.accounts.getBilling(OWNER)).toMatchObject({ status: "canceled" });
  });

  // Fails if an unknown type is an error (Stripe would retry it for days), is recorded, or reads anything.
  it("acknowledges and ignores other types", async () => {
    const { d, cus } = await setup();
    const before = d.fixtureBilling.calls.length;
    for (const type of ["invoice.paid", "customer.created", "constructor"]) expect((await deliver(d, { type, customer: cus })).status).toBe(200);
    expect(d.fixtureBilling.calls.length).toBe(before);
    expect(d.accountsBacking.stripeEvents.size).toBe(0);
  });

  // Fails if a replay is applied again, also when both deliveries race.
  it("applies one event once: a replay and concurrent duplicates change nothing", async () => {
    const { d, cus, clock } = await setup();
    const sub = d.fixtureBilling.subscribe(cus, { priceIds: [PRICES.pro] });
    const body = eventBody({ customer: cus });
    const raced = await Promise.all([send(d, body), send(d, body), send(d, body)]);
    expect(raced.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(d.accountsBacking.stripeEvents.size).toBe(1);
    const stored = await d.accounts.getBilling(OWNER);
    clock.advance(60_000);
    d.fixtureBilling.update(sub.id, { status: "unpaid" });
    expect((await send(d, body)).status).toBe(200);
    expect(await d.accounts.getBilling(OWNER)).toEqual(stored);
  });

  // Fails if an event delivered late brings old state back: the state is always Stripe's, and an older read never wins.
  it("an event delivered out of order cannot overwrite newer state", async () => {
    const { d, cus, clock } = await setup();
    const sub = d.fixtureBilling.subscribe(cus, { priceIds: [PRICES.pro], status: "incomplete" });
    const early = eventBody({ customer: cus });
    d.fixtureBilling.update(sub.id, { status: "active" });
    await deliver(d, { customer: cus });
    clock.advance(5000);
    expect((await send(d, early)).status).toBe(200);
    expect(await d.accounts.getBilling(OWNER)).toMatchObject({ status: "active" });

    // A handler that read before a newer one finishes after it.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let slow = true;
    d.fixtureBilling.before("getSubscriptions", async () => {
      if (!slow) return;
      slow = false;
      await held;
    });
    const first = { ...d, billing: { ...d.billing, getSubscriptions: async (c: string) => { const now = await d.billing.getSubscriptions(c); return now.map((s) => ({ ...s, status: "past_due" })); } } };
    const late = deliver(first, { customer: cus });
    await new Promise((r) => setTimeout(r, 10));
    clock.advance(1000);
    await deliver(d, { customer: cus });
    release();
    expect((await late).status).toBe(200);
    expect(await d.accounts.getBilling(OWNER)).toMatchObject({ status: "active" });
  });

  // Fails if a crash after the event arrived loses it: Stripe must get an error, and the redelivery must apply it.
  it("a failure while applying answers 503 and the redelivery applies the event", async () => {
    const data = createMemoryAccountData();
    const { d, cus } = await setup({ accounts: data });
    d.fixtureBilling.subscribe(cus, { priceIds: [PRICES.pro] });
    const body = eventBody({ customer: cus });
    for (const broken of [{ ...d, accounts: brokenBilling(data, ["applyBillingEvent"]) }, { ...d, accounts: brokenBilling(data, ["getBillingByCustomer"]) }]) expect((await send(broken, body)).status).toBe(503);
    d.fixtureBilling.fail(true);
    expect((await send(d, body)).status).toBe(503);
    expect(await planOf(d)).toBe("free");
    d.fixtureBilling.fail(false);
    expect((await send(d, body)).status).toBe(200);
    expect(await planOf(d)).toBe("pro");
  });

  // Fails if a checkout for one account gives its plan to another, or an event without a customer throws.
  it("ignores a checkout whose reference is another account's, a one-time checkout, and an event without a customer", async () => {
    const { d, cus } = await setup();
    d.fixtureBilling.subscribe(cus, { priceIds: [PRICES.pro] });
    for (const e of [{ type: COMPLETED, customer: cus, ref: OTHER_ACCOUNT.userId }, { type: COMPLETED, customer: cus, ref: null }, { type: COMPLETED, customer: cus, ref: OWNER, mode: "payment" }, { customer: null }, { customer: "not a customer" }]) expect((await deliver(d, e)).status).toBe(200);
    expect(await planOf(d)).toBe("free");
    expect(await d.accounts.getBilling(OTHER_ACCOUNT.userId)).toBeNull();
  });
});

describe("customers without a billing record", () => {
  /** A checkout paid for an account whose record is gone; `userExists`: whether its auth user still is. */
  async function orphan(userExists: boolean) {
    const { d } = billingDeps(0);
    await d.auth.signInWithOtp("orphan@example.test", `${PUBLIC_ORIGIN}/auth/confirm`);
    const userId = d.fixtureAuth.userIdOf("orphan@example.test") as string;
    const cus = await d.billing.createCustomer({ accountId: userId, email: "orphan@example.test" });
    const sub = d.fixtureBilling.subscribe(cus, { priceIds: [PRICES.pro] });
    if (!userExists) await d.auth.deleteUser(userId);
    const status = async () => (await d.billing.getSubscriptions(cus)).find((s) => s.id === sub.id)?.status;
    return { d, userId, cus, status };
  }

  // Fails if a subscription paid during account deletion goes on charging, or a row comes back for the deleted account.
  it.each([COMPLETED, UPDATED])("%s for a deleted account cancels its subscription and creates no row", async (type) => {
    const { d, userId, cus, status } = await orphan(false);
    expect((await deliver(d, { type, customer: cus, ref: userId })).status).toBe(200);
    expect(await status()).toBe("canceled");
    expect(await d.accounts.getBilling(userId)).toBeNull();
    expect(d.accountsBacking.stripeEvents.size).toBe(0);
    for (const s of [userId, cus, "orphan@example.test"]) expect(lines.join("\n")).not.toContain(s);
  });

  // Fails if a failed cancellation is acknowledged (Stripe would never send the event again).
  it("a cancellation that fails answers 503, and the redelivery cancels", async () => {
    const { d, cus, status } = await orphan(false);
    const body = eventBody({ customer: cus });
    d.fixtureBilling.fail(true, "cancelSubscriptions");
    expect((await send(d, body)).status).toBe(503);
    expect(await status()).toBe("active");
    d.fixtureBilling.fail(false);
    expect((await send(d, body)).status).toBe(200);
    expect(await status()).toBe("canceled");
  });

  // Fails if the deletion's own cancellation events start work again.
  it("a deleted subscription's event for a deleted account does nothing", async () => {
    const { d, cus } = await orphan(false);
    const calls = d.fixtureBilling.calls.length;
    expect((await deliver(d, { type: DELETED, customer: cus })).status).toBe(200);
    expect(d.fixtureBilling.calls.length).toBe(calls);
  });

  // Fails if a paid checkout of a living account without a record is lost or cancelled.
  it("a completed checkout links the account again when its auth user exists", async () => {
    const { d, userId, cus, status } = await orphan(true);
    expect((await deliver(d, { customer: cus })).status).toBe(200);
    expect(await d.accounts.getBilling(userId)).toBeNull();
    expect(await status()).toBe("active");
    expect((await deliver(d, { type: COMPLETED, customer: cus, ref: userId })).status).toBe(200);
    expect(await d.accounts.getBilling(userId)).toMatchObject({ customerId: cus, plan: "pro", status: "active" });
  });

  // Fails if a checkout can bind a customer made for another account, or an account that has another customer.
  it("never links a customer to another account, or a second customer to one account", async () => {
    const { d, userId, cus, status } = await orphan(true);
    await d.auth.signInWithOtp("thief@example.test", `${PUBLIC_ORIGIN}/auth/confirm`);
    const thief = d.fixtureAuth.userIdOf("thief@example.test") as string;
    await deliver(d, { type: COMPLETED, customer: cus, ref: thief });
    expect(await d.accounts.getBilling(thief)).toBeNull();
    await d.accounts.linkBillingCustomer(userId, "cus_first");
    await deliver(d, { type: COMPLETED, customer: cus, ref: userId });
    expect((await d.accounts.getBilling(userId))?.customerId).toBe("cus_first");
    expect(await d.accounts.getBillingByCustomer(cus)).toBeNull();
    expect(await status()).toBe("active");
  });

  // Fails if Retrofit cancels another product's subscription, or one another Retrofit deployment made (the same Stripe account).
  it("leaves customers of another product or another deployment alone", async () => {
    for (const owner of [null, { accountId: "00000000-0000-4000-8000-000000000001", origin: "https://other.example" }, { accountId: "not-an-account", origin: PUBLIC_ORIGIN }]) {
      const { d, cus, status } = await orphan(false);
      const elsewhere = { ...d, billing: { ...d.billing, customerOwner: async () => owner } };
      for (const type of [UPDATED, COMPLETED]) expect((await deliver(elsewhere, { type, customer: cus, ref: "00000000-0000-4000-8000-000000000001" })).status).toBe(200);
      expect(await status()).toBe("active");
    }
  });
});

describe("account deletion against a checkout", () => {
  // Fails if a checkout paid at any moment of the deletion leaves a live subscription with no account.
  it.each(["before the cancellation", "after the cancellation", "after the data is deleted", "after the auth user is deleted"])("paid %s: nothing stays active once the webhook arrived", async (when) => {
    const { d } = billingDeps(0);
    await d.auth.signInWithOtp("race@example.test", `${PUBLIC_ORIGIN}/auth/confirm`);
    const userId = d.fixtureAuth.userIdOf("race@example.test") as string;
    const { token } = await createAccountSession(d, { userId, email: "race@example.test" });
    const cookie = `retrofit_account=${token}`;
    const res = await handleCheckout(postRequest("/api/billing/checkout", { plan: "pro" }, { cookie }), d);
    const session = new URL(((await res.json()) as { url: string }).url).searchParams.get("session") as string;
    const cus = (await d.accounts.getBilling(userId))?.customerId as string;
    // A checkout that was paid although deletion closed it: the payment was already under way.
    const pay = () => void (d.fixtureBilling.complete(session) ?? d.fixtureBilling.subscribe(cus, { priceIds: [PRICES.pro] }));
    const accounts = { ...d.accounts, deleteAccountData: async (id: string) => { if (when === "after the cancellation") pay(); await d.accounts.deleteAccountData(id); if (when === "after the data is deleted") pay(); } };
    const auth = { ...d.auth, deleteUser: async (id: string) => { await d.auth.deleteUser(id); if (when === "after the auth user is deleted") pay(); } };
    const racing: TestDeps = { ...d, accounts, auth };
    if (when === "before the cancellation") pay();
    const account = await readAccountByToken(token, d);
    expect(await deleteAccount(racing, account!)).toBe("deleted");
    await deliver(d, { type: COMPLETED, customer: cus, ref: userId });
    await deliver(d, { customer: cus });
    expect((await d.billing.getSubscriptions(cus)).filter((s) => s.status === "active")).toEqual([]);
    expect(await d.accounts.getBilling(userId)).toBeNull();
  });

  // Fails if a late event of a customer whose record is gone in the middle of the write creates it again.
  it("a record deleted while the event is applied is not recreated", async () => {
    const { d, cus } = await setup();
    d.fixtureBilling.subscribe(cus, { priceIds: [PRICES.pro] });
    d.fixtureBilling.before("getSubscriptions", async () => {
      await d.accounts.deleteAccountData(OWNER);
    });
    expect((await deliver(d, { customer: cus })).status).toBe(200);
    expect(await d.accounts.getBilling(OWNER)).toBeNull();
    // No auth user: the subscription ends too.
    expect((await d.billing.getSubscriptions(cus)).map((s) => s.status)).toEqual(["canceled"]);
  });
});
