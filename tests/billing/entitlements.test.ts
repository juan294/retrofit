import { afterEach, describe, expect, it, vi } from "vitest";
import { billingStarted, entitlement } from "@/lib/billing/entitlements";
import { FEATURE_LABELS, PLANS, planIncludes, type Feature, type PlanId } from "@/lib/billing/plans";
import { createMemoryAccountData } from "@/lib/accounts/memory";
import type { StripeSubscription } from "@/lib/billing/state";
import { BILLING_ENV, billingDeps, brokenBilling, OWNER, PRICES, spiedAccounts, START, withBilling } from "./setup";
import { testDeps } from "../helpers/server-deps";

const FEATURES = Object.keys(FEATURE_LABELS) as Feature[];
/** Written out, so a change of plans.ts that moves a feature between plans fails here. */
const EXPECTED: Record<PlanId, readonly Feature[]> = {
  free: ["analyze", "preview_own_key", "download_bundle"],
  pro: ["analyze", "preview_own_key", "download_bundle", "publish", "badge", "saved_reports", "free_ai_preview", "api_keys"],
  agency: ["analyze", "preview_own_key", "download_bundle", "publish", "badge", "saved_reports", "free_ai_preview", "api_keys", "api_high_volume"],
};

afterEach(() => vi.restoreAllMocks());

describe("billing start", () => {
  // Fails if billing starts 1 ms early (a judge would meet a limit) or late.
  it("starts exactly at BILLING_START", () => {
    expect(billingStarted(billingDeps(-1).d)).toBe(false);
    expect(billingStarted(billingDeps(0).d)).toBe(true);
    expect(START).toBe(Date.parse("2027-01-19T00:00:00Z"));
  });
});

describe("entitlements by plan and feature", () => {
  // Fails if a feature is allowed on a plan that does not have it, or refused on one that has it, from the exact instant on.
  it.each(PLANS.flatMap((p) => FEATURES.map((f) => [p.id, f] as const)))("after the start: %s and %s", async (plan, feature) => {
    const { d } = billingDeps(0);
    if (plan !== "free") await withBilling(d, OWNER, { plan });
    const allowed = EXPECTED[plan].includes(feature);
    expect(planIncludes(plan, feature)).toBe(allowed);
    expect(await entitlement(d, OWNER, feature)).toEqual(allowed ? { allowed: true } : { allowed: false, reason: "plan_required" });
  });

  // Fails if anything is refused, or any account data, Store or Stripe call is made, 1 ms before the start.
  it.each(FEATURES)("1 ms before the start: %s is allowed for everybody, and nothing is read", async (feature) => {
    const spy = spiedAccounts(createMemoryAccountData());
    const storeCalls: string[] = [];
    const { d } = billingDeps(-1, { accounts: spy.accounts, instrument: (op) => void storeCalls.push(op) });
    expect(await entitlement(d, null, feature)).toEqual({ allowed: true });
    expect(await entitlement(d, OWNER, feature)).toEqual({ allowed: true });
    expect([spy.calls, storeCalls, d.fixtureBilling.calls]).toEqual([[], [], []]);
  });

  // Fails if a plan whose status gives no access still opens its features.
  it("a plan that is not active counts as Free", async () => {
    const { d } = billingDeps(0);
    await withBilling(d, OWNER, { status: "canceled" });
    expect(await entitlement(d, OWNER, "publish")).toEqual({ allowed: false, reason: "plan_required" });
    expect(await entitlement(d, OWNER, "analyze")).toEqual({ allowed: true });
  });

  // Fails if a visitor without an account gets a paid feature, or any read is made for one.
  it("without an account only the Free features are allowed", async () => {
    const spy = spiedAccounts(createMemoryAccountData());
    const { d } = billingDeps(0, { accounts: spy.accounts });
    expect(await entitlement(d, null, "publish")).toEqual({ allowed: false, reason: "plan_required" });
    expect(await entitlement(d, null, "analyze")).toEqual({ allowed: true });
    expect(spy.calls).toEqual([]);
  });
});

// P5-R2: a stored plan whose time ran out.
describe("a plan whose stored period passed", () => {
  const DAY = 24 * 3600_000;
  /** A Pro account whose stored period ended `days` days after the start, seen `seen` days after it; Stripe has `sub`. */
  async function lapsed(seen: number, sub: Partial<StripeSubscription> | null) {
    const { d, clock } = billingDeps(0);
    const cus = await d.billing.createCustomer({ accountId: OWNER, email: "o@example.test" });
    await d.accounts.ensureProfile(OWNER);
    await d.accounts.linkBillingCustomer(OWNER, cus);
    await d.accounts.applyBillingState(cus, { plan: "pro", status: "active", currentPeriodEnd: new Date(START + DAY).toISOString(), cancelAtPeriodEnd: false, subscriptionId: "sub_unit", unpaidSince: null, observedAt: new Date(START).toISOString() });
    if (sub) d.fixtureBilling.subscribe(cus, { id: "sub_unit", priceIds: [PRICES.pro], ...sub });
    clock.set(START + seen * DAY);
    const reads = () => d.fixtureBilling.calls.filter((c) => c === "getSubscriptions").length;
    return { d, clock, reads };
  }
  const renewed = { currentPeriodEnd: new Date(START + 40 * DAY).toISOString() };

  // Fails if a plan inside its period or its grace asks Stripe, or a missed renewal webhook ends a paid plan.
  it("is read again from Stripe once its grace is over, and a renewal keeps it", async () => {
    const grace = await lapsed(3, renewed);
    expect(await entitlement(grace.d, OWNER, "publish")).toEqual({ allowed: true });
    expect(grace.reads()).toBe(0);
    const over = await lapsed(5, renewed);
    expect(await entitlement(over.d, OWNER, "publish")).toEqual({ allowed: true });
    expect(await entitlement(over.d, OWNER, "publish")).toEqual({ allowed: true });
    expect(over.reads()).toBe(1);
    expect(await over.d.accounts.getBilling(OWNER)).toMatchObject({ currentPeriodEnd: renewed.currentPeriodEnd });
  });

  // Fails if a lost cancellation webhook leaves a plan open for ever.
  it("ends when Stripe says so; while Stripe cannot be asked the answer is a retry, never that a plan is missing", async () => {
    const ended = await lapsed(5, { status: "canceled" });
    expect(await entitlement(ended.d, OWNER, "publish")).toEqual({ allowed: false, reason: "plan_required" });
    const down = await lapsed(5, renewed);
    vi.spyOn(console, "error").mockImplementation(() => {});
    down.d.fixtureBilling.fail(true);
    expect(await entitlement(down.d, OWNER, "publish")).toEqual({ allowed: false, reason: "unavailable" });
    down.d.fixtureBilling.fail(false);
    expect(await entitlement(down.d, OWNER, "publish")).toEqual({ allowed: true });
  });

  // P5-RR7. Fails if a paying customer is told that a plan is needed while another request is reading the renewal, or Stripe is slow.
  it("answers a retry while another read is in progress and when the read takes too long", async () => {
    const busy = await lapsed(5, renewed);
    await busy.d.store.acquireLease(`billing-reconcile:${OWNER}`, 60);
    expect(await entitlement(busy.d, OWNER, "publish")).toEqual({ allowed: false, reason: "unavailable" });
    expect(busy.reads()).toBe(0);
    const slow = await lapsed(5, renewed);
    slow.d.fixtureBilling.before("getSubscriptions", () => new Promise<void>(() => undefined));
    expect(await entitlement(slow.d, OWNER, "publish")).toEqual({ allowed: false, reason: "unavailable" });
  });

  // Fails if requests of an account whose plan stays ended ask Stripe each time.
  it("is not read again for ten minutes when it stays passed", async () => {
    const { d, clock, reads } = await lapsed(5, { currentPeriodEnd: new Date(START + DAY).toISOString() });
    for (let i = 0; i < 5; i++) expect(await entitlement(d, OWNER, "publish")).toEqual({ allowed: false, reason: "plan_required" });
    expect(reads()).toBe(1);
    clock.advance(10 * 60_000);
    await entitlement(d, OWNER, "publish");
    expect(reads()).toBe(2);
  });
});

describe("billing data unreadable", () => {
  // Fails if an outage refuses an analysis (a visit), or opens a paid write.
  it("allows the Free features and denies the paid ones with a retry", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { d } = billingDeps(0, { accounts: brokenBilling(createMemoryAccountData()) });
    expect(await entitlement(d, OWNER, "analyze")).toEqual({ allowed: true });
    for (const f of ["publish", "saved_reports", "free_ai_preview", "api_keys"] as const) expect(await entitlement(d, OWNER, f)).toEqual({ allowed: false, reason: "unavailable" });
  });
});

describe("the default start", () => {
  // Fails if an unset BILLING_START off Vercel, or the fixtures, start billing earlier than the plan's instant.
  it("is the plan's instant without configuration", async () => {
    const unset = { BILLING_START: undefined };
    expect(billingStarted(testDeps({ clock: () => START - 1, env: unset }))).toBe(false);
    expect(billingStarted(testDeps({ clock: () => START, env: unset }))).toBe(true);
    expect(BILLING_ENV.BILLING_START).toBe("2027-01-19T00:00:00Z");
  });
});
