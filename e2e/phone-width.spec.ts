import { test, expect } from "./fixtures/csp";
import { ACCOUNT_TEXT, SAVE_REPORT_TEXT } from "@/lib/site/account-texts";
import { CONFIRM_PATH, markAsAsker, newEmail, signIn, signInFormState } from "./support/account";
import { analyzeFixture, mockOtari } from "./support/agent";
import { claimPanel, claimStates, FLAKY_HOST, FRESH_HOST, MISSING_HOST, mockCheckLimit } from "./support/claims";
import { CLAIMS_TEXT } from "@/lib/site/claims-texts";
import { PUBLISHED_PAGE_TEXT, PUBLISH_TEXT } from "@/lib/site/publish-texts";
import { connectOwnKey, mockPublishLimit, publishStates, verifiedOwner } from "./support/publish";

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
  await connectOwnKey(visitor);
  await expect(visitor.getByTestId("preview-mount").locator(".ns-title").first()).toBeVisible();
  await fits(visitor);
  await pause();
  await fits(page);
  expect((await visitor.goto(visitor.url()))?.status()).toBe(404);
  await expect(visitor.getByRole("heading", { level: 1, name: PUBLISHED_PAGE_TEXT.notFoundTitle })).toBeVisible();
  await fits(visitor);
  await close();
  await claimPanel(page, FLAKY_HOST).getByRole("button", { name: PUBLISH_TEXT.unpublish }).click();
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
  await mockPublishLimit(page);
  await panel.getByRole("button", { name: PUBLISH_TEXT.publish, exact: true }).click();
  await expect(panel.getByRole("alert")).toBeVisible();
  await fits(page);
});
