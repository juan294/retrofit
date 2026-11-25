import { test, expect } from "./fixtures/csp";
import { ACCOUNT_TEXT, SAVE_REPORT_TEXT } from "@/lib/site/account-texts";
import { visitorTexts } from "@/lib/analysis/texts";
import { API_KEY_TEXT, BILLING_TEXT } from "@/lib/site/billing-texts";
import { PLAN_TEXT } from "@/lib/site/plan-texts";
import { PRICING_TEXT } from "@/lib/site/pricing-texts";
import { PUBLISH_TEXT } from "@/lib/site/publish-texts";
import { SIGN_IN_TEXT } from "@/lib/site/sign-in-texts";
import { BASE_URL } from "../playwright.config";
import { mailboxLink, newEmail, openLink, signIn } from "./support/account";
import { analyzeFixture } from "./support/agent";
import { BILLING_HOST, buyPlan, openCheckout, startBilling } from "./support/billing";
import { claimPanel, setClockOffset, verifyByDns, panelButton } from "./support/claims";
import { fixtureOrigin } from "./support/global-setup";
import { pageUrl, publishOn } from "./support/publish";

// Billing, the plans and the free limit (phase-5.md; parent success criterion 7). The server clock moves past
// BILLING_START; the fixtures gateway stands in for Stripe and its checkout page redirects back.

test.describe("plans after BILLING_START", () => {
  test.beforeEach(async ({ request }) => startBilling(request));
  test.afterEach(async ({ request }) => setClockOffset(request, 0));

  // Fails if a Free account publishes or saves, or loses the free AI, a cancelled checkout says nothing or charges, an upgrade does not
  // open publishing at once (no webhook reaches the test server), or the plan outlives the account.
  test("a Free account upgrades to Pro and can publish; a cancelled checkout says so; deleting the account ends it", async ({ page, browser }) => {
    test.setTimeout(120_000);
    await signIn(page, newEmail("billing"));
    await expect(page.getByTestId("plan-name")).toHaveText("Free");
    const id = await analyzeFixture(page, BILLING_HOST);
    await expect(page.getByText("Using Retrofit's free AI")).toBeVisible();
    await expect(page.getByTestId("free-banner")).toHaveCount(0);
    await page.getByRole("button", { name: SAVE_REPORT_TEXT.button }).click();
    await expect(page.getByTestId("save-report").getByRole("alert")).toContainText(PLAN_TEXT.required.saved_reports);
    await expect(page.getByTestId("save-report").getByRole("link", { name: PLAN_TEXT.seePlans })).toHaveAttribute("href", "/pricing");

    await verifyByDns(page, BILLING_HOST);
    const panel = claimPanel(page, BILLING_HOST);
    await panelButton(panel, PUBLISH_TEXT.publish).click();
    await expect(panel.getByTestId("claim-message")).toContainText(PLAN_TEXT.required.publish);
    await expect(panel.getByRole("link", { name: PLAN_TEXT.seePlans })).toHaveAttribute("href", "/pricing");
    expect((await page.request.get(pageUrl(BILLING_HOST))).status()).toBe(404);

    await openCheckout(page, "Pro");
    await page.getByRole("link", { name: "Cancel" }).click();
    await expect(page).toHaveURL(`${BASE_URL}/pricing?checkout=cancelled`);
    await expect(page.getByRole("status").filter({ hasText: BILLING_TEXT.cancelled })).toHaveText("Checkout was cancelled. Nothing was charged.");

    await buyPlan(page, "Pro");
    await expect(page.getByTestId("plan-detail")).toHaveText(/ ?Renews on \d+ February 2036\./);
    await expect(page.getByTestId("plan-activating")).toHaveCount(0);
    await publishOn(page, BILLING_HOST);
    expect((await page.request.get(pageUrl(BILLING_HOST))).status()).toBe(200);
    await page.goto(`/r/${id}`);
    await page.getByRole("button", { name: SAVE_REPORT_TEXT.button }).click();
    await expect(page.getByTestId("save-report").getByRole("status")).toContainText(SAVE_REPORT_TEXT.saved);
    await expect(page.getByTestId("free-banner")).toHaveCount(0);

    // A second plan goes through the portal, never through a second checkout.
    await page.goto("/pricing");
    await page.getByRole("button", { name: BILLING_TEXT.upgrade("Agency") }).click();
    await expect(page.getByTestId("billing-message")).toContainText(BILLING_TEXT.subscribed);
    await page.getByRole("link", { name: BILLING_TEXT.openAccount }).click();
    await page.getByRole("button", { name: BILLING_TEXT.manage }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Fixture billing portal" })).toBeVisible();
    await page.getByRole("link", { name: "Back to Retrofit" }).click();

    await expect(page.getByText(ACCOUNT_TEXT.deleteIntro)).toContainText("it is cancelled at once");
    await page.getByRole("checkbox", { name: ACCOUNT_TEXT.deleteConfirm }).check();
    await page.getByRole("button", { name: ACCOUNT_TEXT.deleteButton }).click();
    await expect(page).toHaveURL(/\/sign-in\?account=deleted$/);
    const visitor = await browser.newContext();
    expect((await visitor.request.get(pageUrl(BILLING_HOST))).status()).toBe(404);
    await visitor.close();
  });

  // Fails if the sixth anonymous analysis runs, its text or the sign-in form is missing, or signing in does not let the visitor go on.
  test("the sixth anonymous analysis shows the sign-in form, and signing in continues", async ({ page }) => {
    const site = fixtureOrigin(BILLING_HOST);
    await page.goto("/");
    const statuses = await page.evaluate(async (url) => {
      const out: number[] = [];
      for (let i = 0; i < 5; i++) out.push((await fetch("/api/analyze", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url }) })).status);
      return out;
    }, site);
    expect(statuses).toEqual([200, 200, 200, 200, 200]);
    await page.getByLabel("Your website address").fill(site);
    await page.getByRole("button", { name: "Score my site" }).click();
    await expect(page.locator("#site-url-error")).toHaveText(visitorTexts.freeLimit);
    expect(visitorTexts.freeLimit).toBe("You've used your 5 free analyses. Sign in to keep going.");

    const email = newEmail("limit");
    await page.locator("#sign-in-email").fill(email);
    await page.getByRole("button", { name: SIGN_IN_TEXT.submit }).click();
    await expect(page.locator("#sign-in-status")).toHaveText(SIGN_IN_TEXT.sent);
    await openLink(page, await mailboxLink(page, email));
    await expect(page).toHaveURL(`${BASE_URL}/`);
    await page.getByLabel("Your website address").fill(site);
    await page.getByRole("button", { name: "Score my site" }).click();
    await expect(page).toHaveURL(/\/r\/[0-9a-f]{32}$/);
  });

  // Fails if a signed-out visitor who chooses a plan is stuck, or the activating text is missing after a checkout Stripe does not show yet.
  test("a signed-out visitor is sent to sign in; an unfinished purchase shows the activating text", async ({ page }) => {
    await page.goto("/pricing");
    await page.getByRole("button", { name: BILLING_TEXT.upgrade("Pro") }).click();
    await expect(page.getByTestId("billing-message")).toContainText(BILLING_TEXT.signedOut);
    await expect(page.getByTestId("billing-message").getByRole("link", { name: PLAN_TEXT.signIn })).toHaveAttribute("href", "/sign-in?returnTo=%2Fpricing");
    await signIn(page, newEmail("activating"), "/pricing");
    await openCheckout(page, "Agency");
    await page.goto("/account?checkout=success");
    await expect(page.getByTestId("plan-activating")).toHaveText("Activating your plan. Reload in a minute.");
    await expect(page.getByTestId("plan-name")).toHaveText("Free");
  });

  // Fails if a key is shown again after a reload, does not work, or works after it was revoked.
  test("an API key is shown once, works, and stops when it is revoked", async ({ page, request }) => {
    await signIn(page, newEmail("keys"));
    await page.getByRole("button", { name: API_KEY_TEXT.create }).click();
    await expect(page.getByTestId("api-keys-message")).toContainText(PLAN_TEXT.required.api_keys);
    await buyPlan(page, "Pro");
    await page.getByRole("button", { name: API_KEY_TEXT.create }).click();
    const key = (await page.getByTestId("api-key").textContent()) ?? "";
    expect(key).toMatch(/^rk_retrofit_[0-9a-f]{32}$/);
    const score = () => request.get(`/api/score?url=${encodeURIComponent(fixtureOrigin(BILLING_HOST))}`, { headers: { authorization: `Bearer ${key}` } });
    expect([200, 202]).toContain((await score()).status());
    await page.reload();
    await expect(page.getByTestId("api-key-item")).toContainText(`Key ending in ${key.slice(-4)}`);
    expect(await page.content()).not.toContain(key);
    // Revoke asks first (UX-M1); the keyboard focus goes to the second step and back, and to the heading when the key is gone (UX-M2).
    const item = page.getByTestId("api-key-item");
    await item.getByRole("button", { name: API_KEY_TEXT.revoke }).click();
    await expect(item.getByTestId("second-step")).toBeFocused();
    await expect(item.getByTestId("second-step")).toContainText(API_KEY_TEXT.revokeQuestion(key.slice(-4)));
    expect([200, 202]).toContain((await score()).status());
    await item.getByRole("button", { name: API_KEY_TEXT.revokeCancel }).click();
    await expect(item.getByRole("button", { name: API_KEY_TEXT.revoke })).toBeFocused();
    await page.keyboard.press("Enter");
    await item.getByRole("button", { name: API_KEY_TEXT.revokeConfirm }).click();
    await expect(page.getByRole("heading", { level: 2, name: API_KEY_TEXT.heading })).toBeFocused();
    await expect(page.getByTestId("api-keys-message")).toHaveText(API_KEY_TEXT.revoked);
    const refused = await score();
    expect(refused.status()).toBe(401);
    expect(((await refused.json()) as { error: string }).error).toBe("invalid_key");
  });

  // Second review. Fails if a judge who is signed in to a Free account cannot turn on judge access after the start.
  test("a judge signed in to a Free account turns on judge access with the code", async ({ page }) => {
    await signIn(page, newEmail("judge"));
    await page.goto("/judges");
    await page.getByLabel("Judge code").fill("wrong-code-e2e");
    await page.getByRole("button", { name: "Turn on judge access" }).click();
    await expect(page.locator("#judge-code-status")).toHaveText("That judge code is not valid.");
    await page.getByLabel("Judge code").fill("judge-code-e2e");
    await page.getByRole("button", { name: "Turn on judge access" }).click();
    await expect(page.locator("#judge-code-status")).toHaveText("Judge access is on for this browser.");
    const status = await page.evaluate(async () => (await fetch("/api/inference/status", { credentials: "same-origin" })).json());
    expect((status as { pool?: unknown }).pool).toBe("judge");
  });

  // Fails if the upgrade buttons are missing after the start, or the plans still say every feature is free.
  test("the pricing page offers the upgrades and no longer the free notice", async ({ page }) => {
    await page.goto("/pricing");
    for (const plan of ["Pro", "Agency"]) await expect(page.getByRole("button", { name: BILLING_TEXT.upgrade(plan) })).toBeEnabled();
    await expect(page.getByTestId("price-pro")).toHaveText("$11.00 per month");
    await expect(page.getByText(PRICING_TEXT.freeNotice)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Notify me" })).toHaveCount(0);
  });
});

test.describe("plans before BILLING_START", () => {
  // Fails if an upgrade is offered, checkout opens, or the account page shows a plan, before the start (free for everyone).
  test("nothing can be bought: no upgrade button, no plan on the account page, and checkout is refused", async ({ page }) => {
    await page.goto("/pricing");
    await expect(page.getByRole("button", { name: "Notify me" })).toBeEnabled();
    await expect(page.getByRole("button", { name: /^Upgrade/ })).toHaveCount(0);
    await expect(page.getByTestId("price-pro")).toHaveText("$11.00 per month");
    await signIn(page, newEmail("before"));
    await expect(page.getByTestId("billing")).toHaveCount(0);
    const status = await page.evaluate(async () => (await fetch("/api/billing/checkout", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ plan: "pro" }) })).status);
    expect(status).toBe(403);
  });
});
