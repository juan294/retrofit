import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { BillingRecord } from "@/lib/accounts/data";
import { BillingSection } from "@/components/billing/BillingSection";
import { ApiKeysSection } from "@/components/billing/ApiKeysSection";
import { BillingButton } from "@/components/billing/BillingButton";
import { billingStep } from "@/components/billing/answer";
import { billingView } from "@/lib/billing/view";
import { BILLING_TEXT } from "@/lib/site/billing-texts";
import { PLAN_TEXT } from "@/lib/site/plan-texts";
import { ACTIVE, OWNER } from "./setup";

const record = (o: Partial<BillingRecord> = {}): BillingRecord => ({ ...ACTIVE, accountId: OWNER, customerId: "cus_secretview", stateAt: "2027-02-01T00:00:00.000Z", ...o });
const NOW = Date.parse("2027-02-10T00:00:00.000Z");
const view = (o: Partial<BillingRecord> | null, plan: "free" | "pro" | "agency", activating = false) => billingView({ plan, record: o === null ? null : record(o), activating }, NOW);

describe("the billing section", () => {
  // Fails if the plan, its renewal or end date, or the way to fix a failed payment is missing or wrong.
  it.each([
    ["no customer", view(null, "free"), { planName: "Free", detail: null, manage: false, activating: false }],
    ["an abandoned checkout", view({ status: "none", plan: "free", currentPeriodEnd: null }, "free"), { planName: "Free", detail: null, manage: true, activating: false }],
    ["active", view({}, "pro"), { planName: "Pro", detail: BILLING_TEXT.renews("1 March 2027"), manage: true, activating: false }],
    ["cancelled at the period end", view({ cancelAtPeriodEnd: true }, "pro"), { planName: "Pro", detail: BILLING_TEXT.ends("1 March 2027"), manage: true, activating: false }],
    ["past due: 7 days from the last paid period, not the unpaid month", view({ status: "past_due", plan: "agency", unpaidSince: "2027-02-09T00:00:00.000Z" }, "agency"), { planName: "Agency", detail: BILLING_TEXT.pastDue("16 February 2027"), manage: true, activating: false }],
    ["a renewal not read yet", view({ currentPeriodEnd: "2027-02-09T00:00:00.000Z" }, "pro"), { planName: "Pro", detail: BILLING_TEXT.renewalPending("9 February 2027"), manage: true, activating: false }],
    ["unpaid", view({ status: "unpaid" }, "free"), { planName: "Free", detail: BILLING_TEXT.notPaid, manage: true, activating: false }],
    ["canceled", view({ status: "canceled" }, "free"), { planName: "Free", detail: BILLING_TEXT.ended, manage: true, activating: false }],
    ["activating", view({ status: "incomplete" }, "free", true), { planName: "Free", detail: null, manage: true, activating: true }],
  ])("%s", (_name, actual, expected) => {
    expect(actual).toEqual(expected);
  });

  // Fails if the stuck-state text changes, a customer id reaches the page, or Free has no way to the plans.
  it("shows the activating text word for word, the plans link for Free, and no Stripe id", () => {
    const html = renderToStaticMarkup(createElement(BillingSection, { view: view({ status: "incomplete" }, "free", true), fixtureOrigin: null }));
    expect(html).toContain("Activating your plan. Reload in a minute.");
    expect(html).toContain('href="/pricing"');
    const paid = renderToStaticMarkup(createElement(BillingSection, { view: view({}, "pro"), fixtureOrigin: null }));
    expect(paid).not.toContain("Activating");
    for (const h of [html, paid]) expect(h).not.toMatch(/cus_|sub_unit/);
    expect(renderToStaticMarkup(createElement(BillingSection, { view: null, fixtureOrigin: null }))).toContain(BILLING_TEXT.unreadable);
  });

  // Fails if a button acts before hydration, or posts anywhere but its API route.
  it("every action is a POST form whose button starts disabled", () => {
    const html = [
      renderToStaticMarkup(createElement(BillingButton, { path: "/api/billing/checkout", body: { plan: "pro" }, label: "Upgrade to Pro", returnTo: "/pricing", fixtureOrigin: null })),
      renderToStaticMarkup(createElement(BillingSection, { view: view({}, "pro"), fixtureOrigin: null })),
      renderToStaticMarkup(createElement(ApiKeysSection, { keys: [{ id: OWNER, hint: "beef", createdOn: "1 March 2027" }] })),
    ].join("");
    const forms = html.match(/<form[^>]*>/g) ?? [];
    expect(forms).toHaveLength(3);
    for (const f of forms) expect(f).toMatch(/method="post"/);
    expect(forms.map((f) => /action="([^"]*)"/.exec(f)?.[1])).toEqual(["/api/billing/checkout", "/api/billing/portal", "/api/account/keys"]);
    for (const b of html.match(/<button[^>]*>/g) ?? []) expect(b).toMatch(/disabled=""/);
    expect(html).toContain("Key ending in beef, created on 1 March 2027");
  });
});

describe("the answer of checkout and the portal in the browser", () => {
  const step = (status: number, body: unknown, fixtureOrigin: string | null = null) => billingStep(status, body, fixtureOrigin, "/pricing");

  // Fails if the browser can be navigated anywhere but Stripe's pages, whatever the server answers.
  it("navigates only to Stripe's pages", () => {
    expect(step(200, { url: "https://checkout.stripe.com/c/pay/1" })).toEqual({ go: "https://checkout.stripe.com/c/pay/1" });
    for (const url of ["https://evil.example/", "javascript:alert(1)", "/account", "http://127.0.0.1:3010/test-fixtures/billing/checkout", undefined]) expect(step(200, { url })).toEqual({ text: BILLING_TEXT.unavailable });
    expect(step(200, { url: "http://127.0.0.1:3010/test-fixtures/billing/checkout?session=1" }, "http://127.0.0.1:3010")).toHaveProperty("go");
    expect(step(500, { url: "https://checkout.stripe.com/c/pay/1" })).toEqual({ text: BILLING_TEXT.unavailable });
  });

  // Fails if a signed-out visitor or a customer with a plan is left without the next step.
  it("sends a signed-out visitor to sign in and a customer to the account page", () => {
    expect(step(401, { error: "signed_out", message: BILLING_TEXT.signedOut })).toEqual({ text: BILLING_TEXT.signedOut, href: "/sign-in?returnTo=%2Fpricing", linkText: PLAN_TEXT.signIn });
    expect(step(409, { error: "subscribed", message: BILLING_TEXT.subscribed, portal: true })).toEqual({ text: BILLING_TEXT.subscribed, href: "/account", linkText: BILLING_TEXT.openAccount });
    expect(step(409, { error: "no_price", message: BILLING_TEXT.noPrice })).toEqual({ text: BILLING_TEXT.noPrice });
    expect(step(503, null)).toEqual({ text: BILLING_TEXT.unavailable });
    expect(PLAN_TEXT.seePlans).toBeTruthy();
  });
});
