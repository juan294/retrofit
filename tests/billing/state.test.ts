import { describe, expect, it } from "vitest";
import { accessUntil, billingState, entitledPlan, needsPortal, STATUS_RULES, timeBoundPassed, type StripeSubscription } from "@/lib/billing/state";

const NOW = Date.parse("2027-02-10T12:00:00.000Z");
const DAY = 24 * 3600_000;
const at = (ms: number) => new Date(NOW + ms).toISOString();
const PRICES = { pro: ["price_pro", "price_pro_old"], agency: ["price_agency"] } as const;
const sub = (o: Partial<StripeSubscription> = {}): StripeSubscription => ({ id: "sub_1", status: "active", priceIds: ["price_pro"], currentPeriodEnd: at(18 * DAY), cancelAtPeriodEnd: false, created: 100, ...o });
const planNow = (o: Partial<StripeSubscription>, now = NOW) => entitledPlan(billingState([sub(o)], PRICES, now), now);

describe("subscription status rules", () => {
  // Fails if a status gains or loses access, or a status Stripe has is missing from the table.
  it("names every Stripe status and its rule", () => {
    expect(STATUS_RULES).toEqual({
      active: "period_end_plus_grace",
      trialing: "period_end_plus_grace",
      past_due: "unpaid_plus_grace",
      unpaid: "none",
      incomplete: "none",
      incomplete_expired: "none",
      paused: "none",
      canceled: "none",
    });
  });

  // P5-R2, P5-R7. Fails if a paid plan has no end in stored state (a lost cancellation would be free for ever), loses its 3 days of
  // grace, keeps them although it was cancelled, or a past due plan keeps a whole unpaid month.
  it.each([
    ["active", { currentPeriodEnd: at(1) }, "pro"],
    ["active at its end", { currentPeriodEnd: at(0) }, "pro"],
    ["active, 3 days less 1 ms past its end", { currentPeriodEnd: at(-3 * DAY + 1) }, "pro"],
    ["active, 3 days past its end", { currentPeriodEnd: at(-3 * DAY) }, "free"],
    ["active without a period end", { currentPeriodEnd: null }, "free"],
    ["trialing in its trial", { status: "trialing", currentPeriodEnd: at(1) }, "pro"],
    ["trialing, 3 days past its end", { status: "trialing", currentPeriodEnd: at(-3 * DAY) }, "free"],
    ["cancelled at the period end, before it", { cancelAtPeriodEnd: true, currentPeriodEnd: at(1) }, "pro"],
    ["cancelled at the period end, at it", { cancelAtPeriodEnd: true, currentPeriodEnd: at(0) }, "free"],
    ["past due, seen for the first time", { status: "past_due" }, "pro"],
    ["past due in the middle of a paid period (a switch whose payment failed)", { status: "past_due", currentPeriodEnd: at(3 * DAY) }, "pro"],
    ["past due, first seen after the period ended", { status: "past_due", currentPeriodEnd: at(-5 * DAY) }, "pro"],
    ["unpaid", { status: "unpaid" }, "free"],
    ["incomplete", { status: "incomplete" }, "free"],
    ["incomplete_expired", { status: "incomplete_expired" }, "free"],
    ["paused", { status: "paused" }, "free"],
    ["canceled", { status: "canceled" }, "free"],
    ["a status Stripe adds later", { status: "a_status_stripe_adds_later" }, "free"],
    ["an inherited name", { status: "constructor" }, "free"],
  ] as const)("%s", (_name, o, expected) => {
    expect(planNow(o)).toBe(expected);
  });

  // P5-RR8. Fails if past due access does not end 7 days after Retrofit first saw it, whatever the period says: earlier for a switch in
  // the middle of a period, or a month later with each unpaid period.
  it("past due keeps access for 7 days from the first time Retrofit saw it", () => {
    const seen = billingState([sub({ status: "past_due", currentPeriodEnd: at(18 * DAY) })], PRICES, NOW);
    expect(seen.unpaidSince).toBe(at(0));
    expect(accessUntil(seen)).toBe(NOW + 7 * DAY);
    expect(entitledPlan(seen, NOW + 7 * DAY - 1)).toBe("pro");
    expect(entitledPlan(seen, NOW + 7 * DAY)).toBe("free");
    expect(entitledPlan({ ...seen, unpaidSince: null }, NOW)).toBe("free");
    expect(billingState([sub()], PRICES, NOW).unpaidSince).toBeNull();
  });

  // P5-R2. Fails if a plan that only ran out of time in the stored state is not read again from Stripe, or one that ended is.
  it("says when a stored plan ran out of time (so it is worth reading again)", () => {
    const passed = (o: Partial<StripeSubscription>) => timeBoundPassed(billingState([sub(o)], PRICES, NOW), NOW);
    expect(passed({ currentPeriodEnd: at(-3 * DAY) })).toBe(true);
    expect(timeBoundPassed(billingState([sub({ status: "past_due" })], PRICES, NOW), NOW + 7 * DAY)).toBe(true);
    expect(passed({ currentPeriodEnd: at(1) })).toBe(false);
    for (const status of ["canceled", "unpaid", "incomplete", "paused"]) expect(passed({ status, currentPeriodEnd: at(-9 * DAY) }), status).toBe(false);
  });
});

describe("plan mapping", () => {
  // Fails if the plan comes from anything but the configured price ids, or an unknown price grants a plan.
  it("maps the plan by price id only", () => {
    expect(billingState([sub({ priceIds: ["price_agency"] })], PRICES, NOW).plan).toBe("agency");
    expect(billingState([sub({ priceIds: ["price_other"] })], PRICES, NOW).plan).toBe("free");
    expect(billingState([sub()], {}, NOW).plan).toBe("free");
    expect(billingState([sub({ priceIds: ["price_other", "price_pro"] })], PRICES, NOW).plan).toBe("pro");
    expect(billingState([sub({ priceIds: ["price_pro", "price_agency"] })], PRICES, NOW).plan).toBe("agency");
    // P5-R5: a price that is no longer for sale still means its plan.
    expect(billingState([sub({ priceIds: ["price_pro_old"] })], PRICES, NOW).plan).toBe("pro");
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
    expect(billingState([], PRICES, NOW)).toEqual({ plan: "free", status: "none", currentPeriodEnd: null, cancelAtPeriodEnd: false, subscriptionId: null, unpaidSince: null });
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
