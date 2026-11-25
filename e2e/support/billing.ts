import type { APIRequestContext, Locator, Page } from "@playwright/test";
import { expect } from "../fixtures/csp";
import { API_KEY_TEXT, BILLING_TEXT } from "@/lib/site/billing-texts";
import { PLAN_TEXT } from "@/lib/site/plan-texts";
import { visitorTexts } from "@/lib/analysis/texts";
import { ACCOUNT_TEXT, SAVE_REPORT_TEXT } from "@/lib/site/account-texts";
import { PRICING_TEXT } from "@/lib/site/pricing-texts";
import { PUBLISH_TEXT } from "@/lib/site/publish-texts";
import { E2E_BILLING_START } from "../../playwright.config";
import { newEmail, signIn } from "./account";
import { analyzeFixture } from "./agent";
import { claimPanel, setClockOffset, verifyByDns, panelButton } from "./claims";

/** The fixture site that only specs after BILLING_START analyze. */
export const BILLING_HOST = "billing.fixture.test";

/** Moves the server clock one hour past BILLING_START (fixtures mode). The caller sets it back to zero. */
export async function startBilling(request: APIRequestContext): Promise<void> {
  await setClockOffset(request, Date.parse(E2E_BILLING_START) + 3600_000 - Date.now());
}

/** On /pricing, opens the checkout of a plan; ends on the fixtures checkout page. */
export async function openCheckout(page: Page, plan: "Pro" | "Agency"): Promise<void> {
  await page.goto("/pricing");
  await page.getByRole("button", { name: BILLING_TEXT.upgrade(plan) }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Fixture checkout" })).toBeVisible();
}

/** Buys a plan for the signed-in account; ends on /account with the plan shown. */
export async function buyPlan(page: Page, plan: "Pro" | "Agency"): Promise<void> {
  await openCheckout(page, plan);
  await page.getByRole("link", { name: "Pay" }).click();
  await expect(page).toHaveURL(/\/account\?checkout=success$/);
  await expect(page.getByTestId("plan-name")).toHaveText(plan);
}

/** Answers POST /api/analyze with the free limit, as the sixth analysis gets it, for the layout and color checks. */
export async function mockFreeLimit(page: Page): Promise<void> {
  await page.route("**/api/analyze", (route) => route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: "free_limit", message: visitorTexts.freeLimit }) }));
}

/** The home page after the free limit: the prompt and the sign-in form. */
export async function freeLimitState(page: Page): Promise<void> {
  await mockFreeLimit(page);
  await page.goto("/");
  await page.getByLabel("Your website address").fill("https://example.com");
  await page.getByRole("button", { name: "Score my site" }).click();
  await expect(page.locator("#site-url-error")).toHaveText(visitorTexts.freeLimit);
  await expect(page.locator("#sign-in-email")).toBeVisible();
}

/**
 * Every new page state of billing, for the layout and color checks: `check` runs on each with its texts.
 * Needs the clock past BILLING_START (startBilling).
 */
export async function billingStates(page: Page, label: string, check: (texts: Record<string, Locator>) => Promise<void>): Promise<void> {
  await freeLimitState(page);
  await check({ limit: page.locator("#site-url-error"), email: page.getByText("Email", { exact: true }).last(), signIn: page.getByRole("button", { name: "Email me a sign-in link" }) });
  await page.unroute("**/api/analyze");

  await page.goto("/pricing?checkout=cancelled");
  await check({ cancelled: page.getByText(BILLING_TEXT.cancelled), price: page.getByTestId("price-pro"), intro: page.getByText(PRICING_TEXT.intro), aiNote: page.getByText(PRICING_TEXT.aiNote), upgrade: page.getByRole("button", { name: BILLING_TEXT.upgrade("Pro") }) });
  await page.getByRole("button", { name: BILLING_TEXT.upgrade("Pro") }).click();
  await check({ signedOut: page.getByTestId("billing-message").filter({ hasText: /\S/ }), link: page.getByTestId("billing-message").filter({ hasText: /\S/ }).getByRole("link", { name: PLAN_TEXT.signIn }) });

  await signIn(page, newEmail(`billing-${label}`));
  await check({ heading: page.getByRole("heading", { level: 2, name: BILLING_TEXT.heading }), plan: page.getByTestId("plan-name"), plans: page.getByTestId("billing").getByRole("link", { name: PLAN_TEXT.seePlans }), keysIntro: page.getByText(API_KEY_TEXT.intro), noKeys: page.getByText(API_KEY_TEXT.none) });
  await page.getByRole("button", { name: API_KEY_TEXT.create }).click();
  await check({ keyRefused: page.getByTestId("api-keys-message") });

  const id = await analyzeFixture(page, BILLING_HOST);
  await page.getByRole("button", { name: SAVE_REPORT_TEXT.button }).click();
  await check({ saveRefused: page.getByTestId("save-report").getByRole("alert"), plans: page.getByTestId("save-report").getByRole("link", { name: PLAN_TEXT.seePlans }) });
  // A failed analysis whose retry meets the free limit.
  await page.route(`**/api/analyze/${id}`, (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ status: "failed", step: "failed", scoreReady: false, failure: { code: "crawl_error", message: visitorTexts.crawlError } }) }));
  await mockFreeLimit(page);
  await page.goto(`/r/${id}`);
  await page.getByRole("button", { name: "Retry" }).click();
  await check({ retryLimit: page.getByText(visitorTexts.freeLimit), signIn: page.getByRole("button", { name: "Email me a sign-in link" }) });
  await page.unroute("**/api/analyze");
  await page.unroute(`**/api/analyze/${id}`);

  await verifyByDns(page, BILLING_HOST);
  const panel = claimPanel(page, BILLING_HOST);
  await panelButton(panel, PUBLISH_TEXT.publish).click();
  await check({ publishRefused: panel.getByTestId("claim-message"), plans: panel.getByRole("link", { name: PLAN_TEXT.seePlans }) });

  await openCheckout(page, "Pro");
  await page.goto("/account?checkout=success");
  await check({ activating: page.getByTestId("plan-activating") });
  await buyPlan(page, "Pro");
  await page.getByRole("button", { name: API_KEY_TEXT.create }).click();
  await check({ detail: page.getByTestId("plan-detail"), manage: page.getByRole("button", { name: BILLING_TEXT.manage }), created: page.getByTestId("api-keys-message"), key: page.getByTestId("api-key"), item: page.getByTestId("api-key-item").locator("span"), revoke: page.getByRole("button", { name: API_KEY_TEXT.revoke }) });
  await page.route("**/api/billing/portal", (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "unavailable", message: BILLING_TEXT.unavailable }) }));
  await page.getByRole("button", { name: BILLING_TEXT.manage }).click();
  await check({ outage: page.getByTestId("billing-message").filter({ hasText: /\S/ }) });
  await page.goto("/account?delete=subscription");
  await check({ kept: page.getByText(ACCOUNT_TEXT.deleteSubscriptionKept), deleteIntro: page.getByText(ACCOUNT_TEXT.deleteIntro) });
  await page.goto("/account?delete=cancelled");
  await check({ cancelled: page.getByText(ACCOUNT_TEXT.deleteFailedCancelled) });
  await page.goto("/account?delete=partial-cancelled");
  await check({ partial: page.getByText(ACCOUNT_TEXT.deletePartialCancelled) });
}
