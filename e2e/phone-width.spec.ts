import { test, expect } from "./fixtures/csp";
import { ACCOUNT_TEXT, SAVE_REPORT_TEXT } from "@/lib/site/account-texts";
import { addressStep, CONFIRM_PATH, newEmail, signIn, signInFormState } from "./support/account";
import { analyzeFixture, mockOtari, submitKey } from "./support/agent";
import { CLAIM_HOST, claimPanel, claimStates, FLAKY_HOST, FRESH_HOST, MISSING_HOST, mockLimit, setClockOffset, panelButton } from "./support/claims";
import { CLAIMS_TEXT } from "@/lib/site/claims-texts";
import { PUBLISHED_PAGE_TEXT, PUBLISH_TEXT } from "@/lib/site/publish-texts";
import { billingStates, startBilling } from "./support/billing";
import { publishedOwner, publishStates, saveTestKey, setOutage, verifiedOwner, pageUrl } from "./support/publish";

test.use({ viewport: { width: 320, height: 640 } });

/** No sideways scrolling at 320 px. */
const fits = async (page: import("@playwright/test").Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBe(0);

// Pages with an agent panel wait for the free AI, so late content (key panel, preview) is measured too.
for (const [path, hasAgent] of [["/", true], ["/conformance", true], ["/bot", false], ["/pricing", false], ["/privacy", false], ["/terms", false], ["/unsubscribe?t=0123456789abcdef0123456789abcdef", false], ["/unsubscribe?t=not-a-token", false], ["/sign-in", false], ["/sign-in?link=expired", false], ["/sign-in?link=unavailable", false], ["/sign-in?link=busy", false], ["/sign-in?account=deleted", false]] as const) {
  test(`${path} fits a 320 px phone screen without sideways scrolling`, async ({ page }) => {
    await page.goto(path);
    if (hasAgent) await expect(page.getByText("Using Retrofit's free AI")).toBeVisible();
    else await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await fits(page);
  });
}

test("the install panel fits a 320 px results page", async ({ page }) => {
  await analyzeFixture(page, "bakery.fixture.test");
  await expect(page.getByRole("link", { name: "Download the files" })).toBeVisible();
  await expect(page.getByTestId("preview-mount").locator(".ns-title").first()).toBeVisible();
  await fits(page);
});


test("the account page, a saved report and the save button fit a 320 px phone screen", async ({ page }) => {
  const id = await analyzeFixture(page, "bakery.fixture.test");
  await signIn(page, newEmail("phone"), `/r/${id}`);
  await page.getByRole("button", { name: SAVE_REPORT_TEXT.button }).click();
  await expect(page.getByTestId("save-report").getByRole("status")).toBeVisible();
  await fits(page);
  await page.goto("/account?delete=failed");
  await expect(page.getByText(ACCOUNT_TEXT.deleteFailed)).toBeVisible();
  await fits(page);
  await page.getByTestId("saved-reports").getByRole("link").first().click();
  await expect(page.getByTestId("score-total")).toBeVisible();
  await fits(page);
});

for (const state of ["sent", "limit", "error"] as const) {
  test(`the sign-in form's ${state} state fits a 320 px phone screen`, async ({ page }) => {
    await signInFormState(page, state);
    await fits(page);
  });
}

test("the sign-in confirm page fits a 320 px phone screen", async ({ page }) => {
  await page.goto(CONFIRM_PATH);
  await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
  await fits(page);
});

test("the sign-in address step fits a 320 px phone screen", async ({ page }) => {
  await addressStep(page);
  await fits(page);
});

test("the save button's error fits a 320 px phone screen", async ({ page }) => {
  const id = await analyzeFixture(page, "bakery.fixture.test");
  await signIn(page, newEmail("phone-error"), `/r/${id}`);
  await page.route("**/api/account/reports", (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "unavailable", message: SAVE_REPORT_TEXT.unavailable }) }));
  await page.getByRole("button", { name: SAVE_REPORT_TEXT.button }).click();
  await expect(page.getByTestId("save-report").getByRole("alert")).toHaveText(SAVE_REPORT_TEXT.unavailable);
  await fits(page);
});

// Phase 3. Fails if a claim panel (lapsed, robots-blocked, tag not found, superseded, a new DNS token, verified, a limit answer) scrolls sideways at 320 px.
test("the claim panels fit a 320 px phone screen", async ({ page, browser }) => {
  test.setTimeout(180_000);
  const { other, close } = await claimStates(page, browser, "phone");
  await expect(page.getByTestId("claim-token")).toBeVisible();
  await expect(claimPanel(page, MISSING_HOST).getByTestId("claim-reason")).toBeVisible();
  await fits(page);
  await mockLimit(page, "/api/claims/check", CLAIMS_TEXT.limit);
  await panelButton(claimPanel(page, FRESH_HOST), CLAIMS_TEXT.checkAgain).click();
  await expect(claimPanel(page, FRESH_HOST).getByRole("alert")).toBeVisible();
  await fits(page);
  await other.setViewportSize({ width: 320, height: 640 });
  await other.goto("/account");
  await expect(other.getByTestId("claim-status")).toHaveText(/^Verified on /);
  await fits(other);
  await panelButton(claimPanel(other, CLAIM_HOST), CLAIMS_TEXT.remove).click();
  await expect(other.getByTestId("second-step")).toBeVisible();
  await fits(other);
  await close();
});

// Phase 4. Fails if the publish controls (Publish, published with the snippet and a failed refresh, paused), the public page (with its key
// panel and its agent) or its 404 page scrolls sideways at 320 px.
test("the publish controls and the published page fit a 320 px phone screen", async ({ page, browser }) => {
  test.setTimeout(120_000);
  const { visitor, pause, close } = await publishStates(page, browser, "phone");
  await expect(claimPanel(page, FLAKY_HOST).getByTestId("badge-snippet")).toBeVisible();
  await fits(page);
  await visitor.setViewportSize({ width: 320, height: 640 });
  await mockOtari(visitor);
  await expect(visitor.getByLabel("Paste your key")).toBeVisible();
  await fits(visitor);
  await submitKey(visitor);
  await expect(visitor.getByTestId("preview-mount").locator(".ns-title").first()).toBeVisible();
  await fits(visitor);
  await pause();
  await fits(page);
  expect((await visitor.goto(visitor.url()))?.status()).toBe(404);
  await expect(visitor.getByRole("heading", { level: 1, name: PUBLISHED_PAGE_TEXT.notFoundTitle })).toBeVisible();
  await fits(visitor);
  await close();
  await panelButton(claimPanel(page, FLAKY_HOST), PUBLISH_TEXT.unpublish).click();
  await expect(claimPanel(page, FLAKY_HOST).getByTestId("claim-message")).toHaveText(PUBLISH_TEXT.unpublished);
  await fits(page);
});

// Phase 4. Fails if the Publish offer or a limit answer scrolls sideways at 320 px.
test("the Publish offer and a limit answer fit a 320 px phone screen", async ({ page }) => {
  test.setTimeout(60_000);
  await verifiedOwner(page, FLAKY_HOST, "phone-offer");
  const panel = claimPanel(page, FLAKY_HOST);
  await expect(panel.getByText(PUBLISH_TEXT.intro)).toBeVisible();
  await fits(page);
  await mockLimit(page, "/api/publish", PUBLISH_TEXT.limit);
  await panelButton(panel, PUBLISH_TEXT.publish).click();
  await expect(panel.getByRole("alert")).toBeVisible();
  await fits(page);
});

// Phase 4 review. Fails if the saved key offer or the outage page of a published site scrolls sideways at 320 px.
test("the saved key offer and the outage page of a published site fit a 320 px phone screen", async ({ page }) => {
  test.setTimeout(60_000);
  await publishedOwner(page, CLAIM_HOST, "phone-outage");
  await saveTestKey(page);
  await page.goto(pageUrl(CLAIM_HOST));
  await expect(page.getByTestId("saved-key")).toBeVisible();
  await fits(page);
  try {
    await setOutage(page, true);
    await page.goto(pageUrl(CLAIM_HOST));
    await expect(page.getByRole("heading", { level: 1, name: PUBLISHED_PAGE_TEXT.unavailableTitle })).toBeVisible();
    await fits(page);
  } finally {
    await setOutage(page, false);
  }
});

// Phase 5. Fails if a billing state (the free limit's sign-in form, the plans with prices and answers, the plan and API key sections,
// a refused publish or save, the cancelled and activating texts, the kept subscription) scrolls sideways at 320 px.
test("the billing states fit a 320 px phone screen", async ({ page }) => {
  test.setTimeout(120_000);
  try {
    await startBilling(page.request);
    await billingStates(page, "phone", async (texts) => {
      for (const [name, el] of Object.entries(texts)) await expect(el, name).toBeVisible();
      await fits(page);
    });
  } finally {
    await setClockOffset(page.request, 0);
  }
});
