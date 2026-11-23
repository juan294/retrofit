import { describe, expect, it } from "vitest";
import { billingState, entitledPlan, needsPortal, STATUS_RULES, type StripeSubscription } from "@/lib/billing/state";

const NOW = Date.parse("2027-02-10T12:00:00.000Z");
const LATER = "2027-02-28T00:00:00.000Z";
const PAST = "2027-02-10T11:59:59.999Z";
const PRICES = { pro: "price_pro", agency: "price_agency" } as const;
const sub = (o: Partial<StripeSubscription> = {}): StripeSubscription => ({ id: "sub_1", status: "active", priceIds: ["price_pro"], currentPeriodEnd: LATER, cancelAtPeriodEnd: false, created: 100, ...o });
const planNow = (o: Partial<StripeSubscription>, now = NOW) => entitledPlan(billingState([sub(o)], PRICES, now), now);

describe("subscription status rules", () => {
  // Fails if a status gains or loses access, or a status Stripe has is missing from the table.
  it("names every Stripe status and its rule", () => {
    expect(STATUS_RULES).toEqual({
      active: "entitled",
      trialing: "entitled",
      past_due: "until_period_end",
      unpaid: "none",
      incomplete: "none",
      incomplete_expired: "none",
      paused: "none",
      canceled: "none",
    });
  });

  // Fails if a status rule is not what the entitlement check applies: each status before and after the period end.
  it.each([
    ["active", "pro", "pro"],
    ["trialing", "pro", "pro"],
    ["past_due", "pro", "free"],
    ["unpaid", "free", "free"],
    ["incomplete", "free", "free"],
    ["incomplete_expired", "free", "free"],
    ["paused", "free", "free"],
    ["canceled", "free", "free"],
    ["a_status_stripe_adds_later", "free", "free"],
    ["constructor", "free", "free"],
  ])("%s: %s before the period end, %s after it", (status, before, after) => {
    expect(planNow({ status, currentPeriodEnd: LATER })).toBe(before);
    expect(planNow({ status, currentPeriodEnd: PAST })).toBe(after);
  });

  // Fails if past_due without a known period end, or exactly at it, keeps access.
  it("past_due ends exactly at the period end, and needs one", () => {
    expect(planNow({ status: "past_due", currentPeriodEnd: new Date(NOW + 1).toISOString() })).toBe("pro");
    expect(planNow({ status: "past_due", currentPeriodEnd: new Date(NOW).toISOString() })).toBe("free");
    expect(planNow({ status: "past_due", currentPeriodEnd: null })).toBe("free");
  });
});

describe("plan mapping", () => {
  // Fails if the plan comes from anything but the configured price ids, or an unknown price grants a plan.
  it("maps the plan by price id only", () => {
    expect(billingState([sub({ priceIds: ["price_agency"] })], PRICES, NOW).plan).toBe("agency");
    expect(billingState([sub({ priceIds: ["price_other"] })], PRICES, NOW).plan).toBe("free");
    expect(billingState([sub()], {}, NOW).plan).toBe("free");
    expect(billingState([sub({ priceIds: ["price_other", "price_pro"] })], PRICES, NOW).plan).toBe("pro");
    expect(billingState([sub({ priceIds: ["pro", "agency", "constructor"] })], PRICES, NOW).plan).toBe("free");
  });

  // Fails if a second, ended or lower subscription hides the one that gives access.
  it("takes the subscription that gives the highest plan now, whatever the order", () => {
    const agency = sub({ id: "sub_a", priceIds: ["price_agency"], created: 50 });
    const pro = sub({ id: "sub_p", created: 99 });
    const ended = sub({ id: "sub_old", status: "canceled", priceIds: ["price_agency"], created: 200 });
    for (const list of [[agency, pro, ended], [ended, pro, agency], [pro, ended, agency]]) expect(billingState(list, PRICES, NOW)).toMatchObject({ subscriptionId: "sub_a", plan: "agency", status: "active" });
    expect(billingState([ended, pro], PRICES, NOW)).toMatchObject({ subscriptionId: "sub_p", plan: "pro" });
  });

  // Fails if a customer without access loses the status that explains why (the newest subscription's).
  it("without access it keeps the newest subscription's status; without any it is none", () => {
    const old = sub({ id: "sub_1", status: "canceled", created: 1 });
    const fresh = sub({ id: "sub_2", status: "incomplete", created: 2 });
    expect(billingState([fresh, old], PRICES, NOW)).toMatchObject({ subscriptionId: "sub_2", status: "incomplete", plan: "pro" });
    expect(billingState([], PRICES, NOW)).toEqual({ plan: "free", status: "none", currentPeriodEnd: null, cancelAtPeriodEnd: false, subscriptionId: null });
    expect(entitledPlan(null, NOW)).toBe("free");
    expect(entitledPlan(billingState([], PRICES, NOW), NOW)).toBe("free");
  });
});

describe("a second checkout", () => {
  // Fails if a customer whose subscription is still open (it can still charge) could buy another one, or an ended one blocks a new purchase.
  it.each([
    ["active", true],
    ["trialing", true],
    ["past_due", true],
    ["unpaid", true],
    ["paused", true],
    ["incomplete", false],
    ["incomplete_expired", false],
    ["canceled", false],
  ])("%s sends to the portal: %s", (status, expected) => {
    expect(needsPortal([sub({ status: "canceled" }), sub({ status })])).toBe(expected);
  });
});
