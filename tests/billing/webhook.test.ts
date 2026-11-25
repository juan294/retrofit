import Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryAccountData } from "@/lib/accounts/memory";
import { deleteAccount } from "@/lib/accounts/delete";
import { createAccountSession, readAccountByToken } from "@/lib/accounts/session";
import { handleCheckout } from "@/lib/api/billing";
import { handleBillingWebhook, MAX_WEBHOOK_BYTES } from "@/lib/api/billing-webhook";
import { ACCOUNT_COOKIE, captureConsole, OTHER_ACCOUNT, postRequest, PUBLIC_ORIGIN, testDeps, type TestDeps, type TestDepsOptions } from "../helpers/server-deps";
import { billingDeps, brokenBilling, customer, OWNER, PRICES, SECRET_KEY, WEBHOOK_SECRET } from "./setup";

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

  // Simplify 13. Fails if an event replayed after its record was pruned (90 days) can bring an old state back: what is applied is always
  // what Stripe says when the replay arrives, read after the stored state.
  it("a replay after the record was pruned applies only what Stripe says now", async () => {
    const { d, cus, clock } = await setup();
    const sub = d.fixtureBilling.subscribe(cus, { priceIds: [PRICES.pro] });
    const body = eventBody({ customer: cus });
    await send(d, body);
    d.fixtureBilling.update(sub.id, { status: "canceled" });
    clock.advance(91 * 24 * 3600_000);
    await deliver(d, { customer: cus });
    const stored = await d.accounts.getBilling(OWNER);
    expect(stored).toMatchObject({ status: "canceled" });
    expect(await d.accounts.pruneStripeEvents(new Date(Date.now() + 10 * 365 * 86_400_000).toISOString(), 100)).toBe(2);
    expect((await send(d, body)).status).toBe(200);
    expect(await d.accounts.getBilling(OWNER)).toMatchObject({ status: "canceled", plan: "pro" });
    expect(Date.parse((await d.accounts.getBilling(OWNER))?.stateAt as string)).toBeGreaterThan(Date.parse(stored?.stateAt as string));
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
    let old = true;
    const first = { ...d, billing: { ...d.billing, getSubscriptions: async (c: string) => { const now = await d.billing.getSubscriptions(c); const was = old; old = false; return was ? now.map((s) => ({ ...s, status: "unpaid" })) : now; } } };
    const late = deliver(first, { customer: cus });
    await new Promise((r) => setTimeout(r, 10));
    clock.advance(1000);
    await deliver(d, { customer: cus });
    release();
    expect((await late).status).toBe(200);
    expect(await d.accounts.getBilling(OWNER)).toMatchObject({ status: "active" });
  });

  // Review nit. Fails if an instance whose clock is behind cannot apply what Stripe says now, or records the event without it.
  it("a newer read is applied although this instance's clock is behind the stored one", async () => {
    const { d, cus, clock } = await setup();
    const sub = d.fixtureBilling.subscribe(cus, { priceIds: [PRICES.pro] });
    await deliver(d, { customer: cus });
    clock.advance(-5 * 60_000 + 120_000);
    d.fixtureBilling.update(sub.id, { status: "canceled" });
    expect((await deliver(d, { customer: cus })).status).toBe(200);
    expect(await d.accounts.getBilling(OWNER)).toMatchObject({ status: "canceled" });
    expect(d.accountsBacking.stripeEvents.size).toBe(2);
  });

  // Review nit. Fails if a read that another instance overtook is recorded as handled without being applied, or is given up.
  it("a read overtaken by another instance is read again and applied", async () => {
    const { d, cus, clock } = await setup();
    const sub = d.fixtureBilling.subscribe(cus, { priceIds: [PRICES.pro] });
    let first = true;
    d.fixtureBilling.before("getSubscriptions", async () => {
      if (!first) return;
      first = false;
      // Another instance, whose clock is ahead, stores its read while this one reads.
      await d.accounts.applyBillingState(cus, { plan: "free", status: "incomplete", currentPeriodEnd: null, cancelAtPeriodEnd: false, subscriptionId: sub.id, unpaidSince: null, observedAt: new Date(clock.now() + 60_000).toISOString() });
    });
    expect((await deliver(d, { customer: cus })).status).toBe(200);
    expect(await d.accounts.getBilling(OWNER)).toMatchObject({ plan: "pro", status: "active" });
    expect(d.accountsBacking.stripeEvents.size).toBe(1);
  });

  // Fails if a customer whose state keeps being overtaken is acknowledged without its state.
  it("a read that is always overtaken answers 503 and records nothing", async () => {
    const { d, cus } = await setup();
    d.fixtureBilling.subscribe(cus, { priceIds: [PRICES.pro] });
    const ahead: TestDeps = { ...d, accounts: { ...d.accounts, applyBillingEvent: async () => ({ outcome: "stale", billing: (await d.accounts.getBilling(OWNER))! }) } };
    expect((await deliver(ahead, { customer: cus })).status).toBe(503);
    expect(d.accountsBacking.stripeEvents.size).toBe(0);
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
  /**
   * A customer with a live subscription and no billing record. `deleted`: its account was deleted here (the mark exists);
   * `user`: its auth user exists; `profile`: so does its profile.
   */
  async function lone(o: { deleted?: boolean; user?: boolean; profile?: boolean } = {}) {
    const { d } = billingDeps(0);
    await d.auth.signInWithOtp("lone@example.test", `${PUBLIC_ORIGIN}/auth/confirm`);
    const userId = d.fixtureAuth.userIdOf("lone@example.test") as string;
    const cus = await d.billing.createCustomer({ accountId: userId, email: "lone@example.test" });
    const sub = d.fixtureBilling.subscribe(cus, { priceIds: [PRICES.pro] });
    if (o.deleted) {
      await d.accounts.ensureProfile(userId);
      await d.accounts.linkBillingCustomer(userId, cus);
      await d.accounts.deleteAccountData(userId);
    }
    if (!o.user) await d.auth.deleteUser(userId);
    if (o.profile) await d.accounts.ensureProfile(userId);
    const status = async () => (await d.billing.getSubscriptions(cus)).find((s) => s.id === sub.id)?.status;
    return { d, userId, cus, status };
  }
  const TYPES = [COMPLETED, UPDATED] as const;
  const quiet = (secrets: readonly string[]) => {
    for (const s of secrets) expect(lines.join("\n")).not.toContain(s);
  };

  // Fails if a subscription paid during account deletion goes on charging, or a row comes back for the deleted account.
  it.each(TYPES)("%s for an account deleted here cancels its subscription and creates no row", async (type) => {
    const { d, userId, cus, status } = await lone({ deleted: true });
    expect((await deliver(d, { type, customer: cus, ref: userId })).status).toBe(200);
    expect(await status()).toBe("canceled");
    expect(await d.accounts.getBilling(userId)).toBeNull();
    expect(d.accountsBacking.stripeEvents.size).toBe(0);
    quiet([userId, cus, "lone@example.test"]);
  });

  // Fails if a deletion that stopped before the auth user (it will be retried) leaves the subscription charging, or binds the customer again.
  it.each(TYPES)("%s while the deletion is not finished cancels too, although the auth user still exists", async (type) => {
    const { d, userId, cus, status } = await lone({ deleted: true, user: true });
    expect((await deliver(d, { type, customer: cus, ref: userId })).status).toBe(200);
    expect(await status()).toBe("canceled");
    expect(await d.accounts.getBilling(userId)).toBeNull();
  });

  // P5-R1. Fails if a missing record or a missing auth user is taken for a deletion: after a restored database or in a new project
  // every paying customer would lose the subscription.
  it.each(TYPES)("%s without a deletion mark never cancels: no account and no record only raise an alert", async (type) => {
    const { d, userId, cus, status } = await lone();
    expect((await deliver(d, { type, customer: cus, ref: userId })).status).toBe(200);
    expect(await status()).toBe("active");
    expect(d.fixtureBilling.calls).not.toContain("cancelSubscriptions");
    expect(await d.accounts.getBilling(userId)).toBeNull();
    expect(d.accountsBacking.stripeEvents.size).toBe(0);
    expect(lines.join("\n")).toContain("[BILLING_ALERT]");
    quiet([userId, cus, "lone@example.test"]);
  });

  // DO-M2, BE-L2. Fails if the owner is not told of a paying customer without an account, is told at every event, or the issue (in a public
  // repository) names the customer, the account or an address.
  it("opens one issue for such a customer, without naming it", async () => {
    const issues: string[] = [];
    vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => (issues.push(String(init?.body)), new Response("{}", { status: 201 })));
    try {
      const { d, userId, cus } = await lone();
      const deps = { ...d, config: { ...d.config, free: { ...d.config.free, alertGithubToken: "github-token-unit" } } };
      for (const type of [COMPLETED, UPDATED]) await deliver(deps, { type, customer: cus, ref: userId });
      await d.settle();
      expect(issues).toHaveLength(1);
      expect(JSON.parse(issues[0]!).title).toBe("A Stripe customer has no account");
      for (const secret of [userId, cus, "example.test"]) expect(issues[0]).not.toContain(secret);
      expect(d.errors).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  // P5-R1. Fails if an outage at any step cancels, acknowledges the event (Stripe would never send it again) or records it.
  it.each([
    ["the billing record", (d: TestDeps): TestDeps => ({ ...d, accounts: brokenBilling(d.accounts, ["getBillingByCustomer"]) })],
    ["the deletion mark", (d: TestDeps): TestDeps => ({ ...d, accounts: brokenBilling(d.accounts, ["isDeletedCustomer"]) })],
    ["the customer's owner", (d: TestDeps): TestDeps => ({ ...d, billing: { ...d.billing, customerOwner: async () => { throw new Error("down"); } } })],
    ["the auth user", (d: TestDeps): TestDeps => ({ ...d, auth: { ...d.auth, getUser: async () => { throw new Error("down"); } } })],
    ["the link", (d: TestDeps): TestDeps => ({ ...d, accounts: brokenBilling(d.accounts, ["linkBillingCustomer"]) })],
  ])("an outage of %s answers 503, cancels nothing and records nothing; the redelivery works", async (_step, broken) => {
    const { d, userId, cus, status } = await lone({ user: true, profile: true });
    const body = eventBody({ customer: cus });
    expect((await send(broken(d), body)).status).toBe(503);
    expect(await status()).toBe("active");
    expect(d.accountsBacking.stripeEvents.size).toBe(0);
    expect((await send(d, body)).status).toBe(200);
    expect(await d.accounts.getBilling(userId)).toMatchObject({ customerId: cus, plan: "pro" });
  });

  // Fails if a failed cancellation is acknowledged (Stripe would never send the event again).
  it("a cancellation that fails answers 503, and the redelivery cancels", async () => {
    const { d, cus, status } = await lone({ deleted: true });
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
    const { d, cus } = await lone({ deleted: true });
    const calls = d.fixtureBilling.calls.length;
    expect((await deliver(d, { type: DELETED, customer: cus })).status).toBe(200);
    expect(d.fixtureBilling.calls.length).toBe(calls);
  });

  // P5-R8. Fails if a paying, living account whose record was lost stays Free although Stripe reports it, whatever the event.
  it.each([COMPLETED, UPDATED, DELETED])("%s links a living account of this Retrofit that has no record", async (type) => {
    const { d, userId, cus, status } = await lone({ user: true, profile: true });
    expect((await deliver(d, { type, customer: cus, ref: userId })).status).toBe(200);
    expect(await d.accounts.getBilling(userId)).toMatchObject({ customerId: cus, plan: "pro", status: "active" });
    expect(await status()).toBe("active");
  });

  // Fails if a customer is bound to an account it was not created for, of another deployment, without a profile, or that has another customer.
  it("never links a customer to another account, another deployment's account, an account without a profile, or a second customer to one account", async () => {
    const a = await lone({ user: true, profile: true });
    await a.d.auth.signInWithOtp("thief@example.test", `${PUBLIC_ORIGIN}/auth/confirm`);
    const thief = a.d.fixtureAuth.userIdOf("thief@example.test") as string;
    await a.d.accounts.ensureProfile(thief);
    await deliver(a.d, { type: COMPLETED, customer: a.cus, ref: thief });
    expect(await a.d.accounts.getBilling(thief)).toBeNull();
    expect(await a.d.accounts.getBilling(a.userId)).toBeNull();
    for (const owner of [{ accountId: a.userId, origin: "https://other.example" }, { accountId: "not-an-account", origin: PUBLIC_ORIGIN }, null]) {
      const elsewhere = { ...a.d, billing: { ...a.d.billing, customerOwner: async () => owner } };
      await deliver(elsewhere, { customer: a.cus });
      expect(await a.d.accounts.getBilling(a.userId)).toBeNull();
    }
    await a.d.accounts.linkBillingCustomer(a.userId, "cus_first");
    await deliver(a.d, { type: COMPLETED, customer: a.cus, ref: a.userId });
    expect((await a.d.accounts.getBilling(a.userId))?.customerId).toBe("cus_first");
    expect(await a.d.accounts.getBillingByCustomer(a.cus)).toBeNull();
    expect(await a.status()).toBe("active");

    const noProfile = await lone({ user: true });
    await deliver(noProfile.d, { customer: noProfile.cus });
    expect(await noProfile.d.accounts.getBilling(noProfile.userId)).toBeNull();
    expect(await noProfile.status()).toBe("active");
  });

  // Fails if another product's customer (the same Stripe account) raises an alert for each of its events, or is touched.
  it("leaves customers of another product alone, without an alert", async () => {
    const { d, cus, status } = await lone();
    const elsewhere = { ...d, billing: { ...d.billing, customerOwner: async () => null } };
    for (const type of [UPDATED, COMPLETED, DELETED]) expect((await deliver(elsewhere, { type, customer: cus, ref: null })).status).toBe(200);
    expect(await status()).toBe("active");
    expect(lines).toEqual([]);
  });
});

describe("account deletion against a checkout", () => {
  // Fails if a checkout paid at any moment of the deletion leaves a live subscription with no account.
  it.each(["before the cancellation", "after the cancellation", "after the data is deleted", "after the auth user is deleted"])("paid %s: nothing stays active once the webhook arrived", async (when) => {
    const { d } = billingDeps(0);
    await d.auth.signInWithOtp("race@example.test", `${PUBLIC_ORIGIN}/auth/confirm`);
    const userId = d.fixtureAuth.userIdOf("race@example.test") as string;
    await d.accounts.ensureProfile(userId);
    const { token } = await createAccountSession(d, { userId, email: "race@example.test" });
    const cookie = `${ACCOUNT_COOKIE}=${token}`;
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
    expect(await deleteAccount(racing, account!)).toMatchObject({ stage: "deleted" });
    await deliver(d, { type: COMPLETED, customer: cus, ref: userId });
    await deliver(d, { customer: cus });
    expect((await d.billing.getSubscriptions(cus)).filter((s) => s.status === "active")).toEqual([]);
    expect(await d.accounts.getBilling(userId)).toBeNull();
  });

  // P5-R1. Fails if a checkout request that was already under way when its account was deleted can still bind a customer and open a
  // checkout, or leaves a row for the deleted account.
  it("a checkout request overtaken by the deletion opens nothing", async () => {
    const { d } = billingDeps(0);
    await d.auth.signInWithOtp("late@example.test", `${PUBLIC_ORIGIN}/auth/confirm`);
    const userId = d.fixtureAuth.userIdOf("late@example.test") as string;
    await d.accounts.ensureProfile(userId);
    const { token } = await createAccountSession(d, { userId, email: "late@example.test" });
    const account = await readAccountByToken(token, d);
    d.fixtureBilling.before("createCustomer", async () => {
      expect(await deleteAccount(d, account!)).toMatchObject({ stage: "deleted" });
    });
    const res = await handleCheckout(postRequest("/api/billing/checkout", { plan: "pro" }, { cookie: `${ACCOUNT_COOKIE}=${token}` }), d);
    expect(res.status).toBe(401);
    expect(d.fixtureBilling.calls).not.toContain("createCheckout");
    expect(await d.accounts.getBilling(userId)).toBeNull();
  });

  // P5-RR3. The one moment the deletion mark does not cover: between the deletion of the data and of the auth user, another tab of the
  // deleting browser (its session is kept for a retry) buys a plan; the new record goes with the auth user (its foreign key cascades) and
  // leaves no mark. Fails if a later payment is then cancelled without proof, or passes without an alert to the owner, or if a new sign-in
  // can still reach that moment (Strix 2026-11-25).
  it("a checkout opened between the data and the auth user is not cancelled when it is paid later: it raises the alert", async () => {
    const { d } = billingDeps(0);
    await d.auth.signInWithOtp("window@example.test", `${PUBLIC_ORIGIN}/auth/confirm`);
    const userId = d.fixtureAuth.userIdOf("window@example.test") as string;
    await d.accounts.ensureProfile(userId);
    const { token } = await createAccountSession(d, { userId, email: "window@example.test" });
    const account = await readAccountByToken(token, d);
    let session = "";
    const auth = {
      ...d.auth,
      deleteUser: async (id: string) => {
        await d.accounts.ensureProfile(id);
        await expect(createAccountSession(d, { userId: id, email: "window@example.test" })).rejects.toThrow("being deleted");
        const res = await handleCheckout(postRequest("/api/billing/checkout", { plan: "pro" }, { cookie: `${ACCOUNT_COOKIE}=${token}` }), d);
        session = new URL(((await res.json()) as { url: string }).url).searchParams.get("session") as string;
        await d.auth.deleteUser(id);
        // As the database does: the rows of a deleted auth user go with it.
        d.accountsBacking.billing.delete(id);
        d.accountsBacking.profiles.delete(id);
      },
    };
    expect(await deleteAccount({ ...d, auth }, account!)).toMatchObject({ stage: "deleted" });
    const cus = d.fixtureBilling.session(session)?.customerId as string;
    expect(d.fixtureBilling.complete(session)).not.toBeNull();
    lines.length = 0;
    for (const type of [COMPLETED, UPDATED]) expect((await deliver(d, { type, customer: cus, ref: userId })).status).toBe(200);
    expect((await d.billing.getSubscriptions(cus)).map((s) => s.status)).toEqual(["active"]);
    expect(lines.filter((l) => l.includes("[BILLING_ALERT]"))).toHaveLength(2);
    await d.settle();
    expect(d.errors).toEqual([]);
    expect(await d.accounts.getBilling(userId)).toBeNull();
    for (const secret of [userId, cus, "window@example.test"]) expect(lines.join("\n")).not.toContain(secret);
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
    // The deletion marked the customer: its subscription ends too.
    expect((await d.billing.getSubscriptions(cus)).map((s) => s.status)).toEqual(["canceled"]);
  });
});
