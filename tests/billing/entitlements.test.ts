import { afterEach, describe, expect, it, vi } from "vitest";
import { billingStarted, entitlement } from "@/lib/billing/entitlements";
import { FEATURE_LABELS, PLANS, planIncludes, type Feature, type PlanId } from "@/lib/billing/plans";
import { createMemoryAccountData } from "@/lib/accounts/memory";
import { BILLING_ENV, billingDeps, brokenBilling, OWNER, spiedAccounts, START, withBilling } from "./setup";
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
