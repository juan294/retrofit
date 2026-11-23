import { test, expect } from "./fixtures/csp";
import { ACCOUNT_TEXT, SAVE_REPORT_TEXT } from "@/lib/site/account-texts";
import { CONFIRM_PATH, markAsAsker, newEmail, signIn, signInFormState } from "./support/account";
import { analyzeFixture } from "./support/agent";
import { claimPanel, claimStates, FRESH_HOST, MISSING_HOST, mockCheckLimit } from "./support/claims";
import { CLAIMS_TEXT } from "@/lib/site/claims-texts";

test.use({ viewport: { width: 320, height: 640 } });

/** No sideways scrolling at 320 px. */
const fits = async (page: import("@playwright/test").Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBe(0);

// Pages with an agent panel wait for the free AI, so late content (key panel, preview) is measured too.
for (const [path, hasAgent] of [["/", true], ["/conformance", true], ["/bot", false], ["/pricing", false], ["/privacy", false], ["/terms", false], ["/unsubscribe?t=0123456789abcdef0123456789abcdef", false], ["/unsubscribe?t=not-a-token", false], ["/sign-in", false], ["/sign-in?link=expired", false], ["/sign-in?link=unavailable", false], ["/sign-in?account=deleted", false]] as const) {
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

for (const asker of [false, true]) {
  test(`the sign-in confirm page ${asker ? "without" : "with"} the other-browser warning fits a 320 px phone screen`, async ({ page }) => {
    if (asker) await markAsAsker(page);
    await page.goto(CONFIRM_PATH);
    await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
    await expect(page.getByTestId("other-browser")).toHaveCount(asker ? 0 : 1);
    await fits(page);
  });
}

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
  await mockCheckLimit(page);
  await claimPanel(page, FRESH_HOST).getByRole("button", { name: CLAIMS_TEXT.checkAgain }).click();
  await expect(claimPanel(page, FRESH_HOST).getByRole("alert")).toBeVisible();
  await fits(page);
  await other.setViewportSize({ width: 320, height: 640 });
  await other.goto("/account");
  await expect(other.getByTestId("claim-status")).toHaveText(/^Verified on /);
  await fits(other);
  await close();
});
