import { afterEach, describe, expect, it, vi } from "vitest";
import { formatAmount, planAmounts } from "@/lib/billing/prices";
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

  it("names the configured prices only", () => {
    expect(Object.values(PRICES)).toHaveLength(2);
  });
});
