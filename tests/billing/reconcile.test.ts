import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { accountBilling, RECONCILE_AFTER_MS } from "@/lib/billing/reconcile";
import { TEST_ACCOUNT, captureConsole, type TestDeps } from "../helpers/server-deps";
import { billingDeps, OWNER, PRICES, SECRET_KEY } from "./setup";

const lines: string[] = [];
beforeEach(() => {
  lines.length = 0;
  captureConsole(lines);
});
afterEach(() => vi.restoreAllMocks());

const MIN = 60_000;
async function customer(d: TestDeps): Promise<string> {
  const id = await d.billing.createCustomer({ accountId: OWNER, email: TEST_ACCOUNT.email });
  await d.accounts.linkBillingCustomer(OWNER, id);
  return id;
}
const reads = (d: TestDeps) => d.fixtureBilling.calls.filter((c) => c === "getSubscriptions").length;
const load = (d: TestDeps, o: { checkout?: boolean; waitMs?: number } = {}) => accountBilling(d, OWNER, { checkout: false, ...o });

describe("the account page's billing", () => {
  // Fails if an account that never paid costs a Stripe call or shows a plan.
  it("an account without a customer is Free and asks Stripe nothing", async () => {
    const { d } = billingDeps(0);
    expect(await load(d, { checkout: true })).toEqual({ plan: "free", record: null, activating: false });
    expect(d.fixtureBilling.calls).toEqual([]);
  });

  // Fails if a missed webhook keeps a paying customer on Free.
  it("a missed webhook is fixed on load", async () => {
    const { d } = billingDeps(0);
    const cus = await customer(d);
    d.fixtureBilling.subscribe(cus, { priceIds: [PRICES.pro] });
    expect(await load(d)).toMatchObject({ plan: "pro", activating: false, record: { status: "active" } });
    expect(await d.accounts.getBilling(OWNER)).toMatchObject({ plan: "pro" });
  });

  // Fails if every load asks Stripe, or a state older than 10 minutes is never read again (a missed cancellation).
  it("asks Stripe again only when the state is 10 minutes old", async () => {
    const { d, clock } = billingDeps(0);
    const cus = await customer(d);
    const sub = d.fixtureBilling.subscribe(cus, { priceIds: [PRICES.pro] });
    await load(d);
    expect(reads(d)).toBe(1);
    d.fixtureBilling.update(sub.id, { status: "canceled" });
    expect(RECONCILE_AFTER_MS).toBe(10 * MIN);
    clock.advance(10 * MIN - 1);
    expect((await load(d)).plan).toBe("pro");
    expect(reads(d)).toBe(1);
    clock.advance(1);
    expect((await load(d)).plan).toBe("free");
    expect(reads(d)).toBe(2);
  });

  // Fails if returning from checkout shows the plan bought a moment ago only 10 minutes later.
  it("returning from checkout asks Stripe at once", async () => {
    const { d, clock } = billingDeps(0);
    const cus = await customer(d);
    await load(d);
    d.fixtureBilling.subscribe(cus, { priceIds: [PRICES.agency] });
    clock.advance(30_000);
    expect((await load(d)).plan).toBe("free");
    expect(await load(d, { checkout: true })).toMatchObject({ plan: "agency", activating: false });
  });

  // Fails if the customer is not told the plan is on its way, or a visitor who bought nothing is told so.
  it("shows the activating state after a checkout that Stripe does not show yet, and when Stripe is unreachable", async () => {
    const { d, clock } = billingDeps(0);
    const cus = await customer(d);
    d.fixtureBilling.subscribe(cus, { priceIds: [PRICES.pro], status: "incomplete" });
    expect(await load(d, { checkout: true })).toMatchObject({ plan: "free", activating: true });
    clock.advance(11 * MIN);
    expect(await load(d)).toMatchObject({ plan: "free", activating: false });
    clock.advance(11 * MIN);
    d.fixtureBilling.fail(true);
    expect(await load(d)).toMatchObject({ plan: "free", activating: true });
    expect(lines.join("\n")).not.toContain(SECRET_KEY);
  });

  // Fails if a Stripe outage takes a paid plan away.
  it("keeps the stored plan when Stripe is unreachable", async () => {
    const { d, clock } = billingDeps(0);
    const cus = await customer(d);
    d.fixtureBilling.subscribe(cus, { priceIds: [PRICES.pro] });
    await load(d);
    clock.advance(11 * MIN);
    d.fixtureBilling.fail(true);
    expect(await load(d)).toMatchObject({ plan: "pro", activating: false, record: { status: "active" } });
  });

  // Fails if a slow Stripe holds the page, or an unfinished read breaks it later.
  it("does not wait longer than its limit", async () => {
    const { d } = billingDeps(0);
    await customer(d);
    let release!: () => void;
    d.fixtureBilling.before("getSubscriptions", () => new Promise<void>((r) => (release = r)));
    const started = Date.now();
    expect(await load(d, { waitMs: 40 })).toMatchObject({ plan: "free", activating: true });
    expect(Date.now() - started).toBeLessThan(1500);
    d.fixtureBilling.fail(true);
    release();
    await new Promise((r) => setTimeout(r, 10));
  });

  // Fails if several loads (tabs, reloads, instances) each ask Stripe at the same time.
  it("asks Stripe once at a time per account", async () => {
    const { d, clock } = billingDeps(0);
    const cus = await customer(d);
    d.fixtureBilling.subscribe(cus, { priceIds: [PRICES.pro] });
    const all = await Promise.all(Array.from({ length: 6 }, () => load(d, { checkout: true })));
    expect(reads(d)).toBe(1);
    expect(all.filter((r) => r.plan === "pro").length).toBeGreaterThanOrEqual(1);
    for (const r of all) expect(r.plan === "pro" || r.activating).toBe(true);
    // The read that ended does not hold up the next one: paying right after a load is seen at once.
    clock.advance(1);
    await load(d, { checkout: true });
    expect(reads(d)).toBe(2);
  });

  // Fails if a read that failed keeps the lease (the next load would wait for it to expire).
  it("a failed read gives its lease back", async () => {
    const { d } = billingDeps(0);
    const cus = await customer(d);
    d.fixtureBilling.subscribe(cus, { priceIds: [PRICES.pro] });
    d.fixtureBilling.fail(true);
    await load(d);
    d.fixtureBilling.fail(false);
    expect((await load(d)).plan).toBe("pro");
  });

  // Fails if a reload loop asks Stripe without limit.
  it("asks Stripe at most 60 times an hour per account", async () => {
    const { d, clock } = billingDeps(0);
    await customer(d);
    for (let i = 0; i < 70; i++) await load(d, { checkout: true });
    expect(reads(d)).toBe(60);
    clock.advance(3600_000);
    await load(d, { checkout: true });
    expect(reads(d)).toBe(61);
  });

  // Fails if the page fails when only the lease Store fails.
  it("shows the stored plan when the Store is down", async () => {
    const { d } = billingDeps(0);
    const cus = await customer(d);
    d.fixtureBilling.subscribe(cus, { priceIds: [PRICES.pro] });
    const broken: TestDeps = { ...d, store: { ...d.store, acquireLease: async () => { throw new Error("down"); } } };
    expect(await load(broken)).toMatchObject({ plan: "free", activating: true });
  });
});
