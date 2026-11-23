import { afterEach, describe, expect, it, vi } from "vitest";
import { formatAmount, planAmounts, planOffer } from "@/lib/billing/prices";
import { captureConsole, type TestDeps } from "../helpers/server-deps";
import { billingDeps, PRICES } from "./setup";

afterEach(() => vi.restoreAllMocks());
const reads = (d: TestDeps) => d.fixtureBilling.calls.filter((c) => c === "getPrice").length;

describe("plan amounts", () => {
  // Fails if an amount is invented for a plan without a price, or Stripe is asked without one.
  it("shows no amount for a plan without a price id, and asks nothing", async () => {
    const { d } = billingDeps(0, { env: { STRIPE_PRICE_PRO: "", STRIPE_PRICE_AGENCY: "" } });
    expect(await planAmounts(d)).toEqual({});
    expect(d.fixtureBilling.calls).toEqual([]);
  });

  // Fails if each page view asks Stripe, or a changed amount is shown for longer than an hour.
  it("reads each configured price once an hour", async () => {
    const { d, clock } = billingDeps(0);
    expect(await planAmounts(d)).toEqual({ pro: "$11.00 per month", agency: "$22.00 per month" });
    await planAmounts(d);
    expect(reads(d)).toBe(2);
    clock.advance(3_600_000);
    await planAmounts(d);
    expect(reads(d)).toBe(4);
  });

  // Fails if an outage breaks the page, shows an old or invented amount as new, or asks Stripe on every view.
  it("shows no amount while Stripe is unreachable, and asks again a minute later", async () => {
    captureConsole([]);
    const { d, clock } = billingDeps(0);
    d.fixtureBilling.fail(true);
    expect(await planAmounts(d)).toEqual({});
    await planAmounts(d);
    expect(reads(d)).toBe(2);
    d.fixtureBilling.fail(false);
    clock.advance(60_000);
    expect(await planAmounts(d)).toEqual({ pro: "$11.00 per month", agency: "$22.00 per month" });
  });

  // Fails if a slow Stripe holds the pricing page.
  it("does not wait longer than its limit", async () => {
    const { d } = billingDeps(0);
    d.fixtureBilling.before("getPrice", () => new Promise<void>(() => undefined));
    const started = Date.now();
    expect(await planAmounts(d, 30)).toEqual({});
    expect(Date.now() - started).toBeLessThan(1500);
  });

  // Simplify 11. Fails if several views read one price at the same time, or a read that came late is thrown away.
  it("views share one read, and a late answer is kept", async () => {
    const { d, clock } = billingDeps(0);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    d.fixtureBilling.before("getPrice", () => held);
    expect(await Promise.all([planAmounts(d, 20), planAmounts(d, 20), planAmounts(d, 20)])).toEqual([{}, {}, {}]);
    expect(reads(d)).toBe(2);
    release();
    await new Promise((r) => setTimeout(r, 5));
    expect(await planAmounts(d, 20)).toEqual({ pro: "$11.00 per month", agency: "$22.00 per month" });
    expect(reads(d)).toBe(2);
    clock.advance(3_600_000);
    await planAmounts(d);
    expect(reads(d)).toBe(4);
  });

  // Fails if a currency without cents is shown a hundred times too small, or a broken currency throws.
  it.each([
    [{ amount: 1900, currency: "eur", interval: "month" }, "€19.00 per month"],
    [{ amount: 1900, currency: "jpy", interval: "month" }, "¥1,900 per month"],
    [{ amount: 12050, currency: "usd", interval: "year" }, "$120.50 per year"],
    [{ amount: 500, currency: "usd", interval: null }, "$5.00"],
    [{ amount: 500, currency: "not a currency", interval: "month" }, null],
  ])("formats %j as %s", (price, text) => {
    expect(formatAmount(price)).toBe(text);
  });

  // P5-R11. Fails if a plan can be bought before the start, without a price, or without its amount on the page.
  it.each([
    [{ started: false, priced: true, amount: "$11.00 per month" }, { amount: "$11.00 per month", upgrade: false, unavailable: false }],
    [{ started: true, priced: true, amount: "$11.00 per month" }, { amount: "$11.00 per month", upgrade: true, unavailable: false }],
    [{ started: true, priced: true, amount: undefined }, { amount: null, upgrade: false, unavailable: true }],
    [{ started: true, priced: false, amount: undefined }, { amount: null, upgrade: false, unavailable: false }],
    [{ started: false, priced: true, amount: undefined }, { amount: null, upgrade: false, unavailable: false }],
  ])("a plan's offer for %j", (o, expected) => {
    expect(planOffer(o)).toEqual(expected);
  });

  // P5-R5. Fails if the page shows the amount of a price that is no longer for sale.
  it("shows the price for sale, the first of the list", async () => {
    const { d } = billingDeps(0, { env: { STRIPE_PRICE_PRO: `price_unit_new,${PRICES.pro}` } });
    const asked: string[] = [];
    await planAmounts({ ...d, billing: { ...d.billing, getPrice: async (id) => { asked.push(id); return null; } } });
    expect(asked.sort()).toEqual([PRICES.agency, "price_unit_new"].sort());
  });
});
