import { test, expect } from "./fixtures/csp";
import { FIXTURE_CLAIM_TOKEN } from "@/lib/claims/host";
import { CLAIMS_TEXT } from "@/lib/site/claims-texts";
import { newEmail, signIn } from "./support/account";
import { analyzeAny, BLOCKED_HOST, CLAIM_HOST, claimHostOf, claimPanel, claimSite, checkAgain, FLAKY_HOST, lapseFlaky, runRecheck, setClockOffset, setFlakyTag } from "./support/claims";

// Ownership claims (phase-3.md; parent success criterion 4). Fixtures mode gives every fixture-host claim one
// token (FIXTURE_CLAIM_TOKEN): claim.fixture.test serves its tag, flaky.fixture.test serves it while switched on,
// and the fixtures TXT resolver answers the record for blocked.fixture.test.
test.describe("ownership claims", () => {
  test.afterEach(async ({ request }) => {
    await setClockOffset(request, 0);
    await setFlakyTag(request, true);
  });

  // Fails if a claim by meta tag does not verify, the token shows again after a reload, or a second account's
  // verification does not move the host to it with the moved text for the first account.
  test("claim a fixture site by meta tag, see it verified, and see it move to a second account", async ({ page, browser }) => {
    await signIn(page, newEmail("claims-meta"));
    await analyzeAny(page, CLAIM_HOST);
    const panel = await claimSite(page, CLAIM_HOST, "meta");
    await expect(panel.getByTestId("claim-token").locator("code")).toHaveText(CLAIMS_TEXT.metaTag(FIXTURE_CLAIM_TOKEN));
    await expect(panel.getByTestId("claim-status")).toHaveText(CLAIMS_TEXT.status.pending);
    await checkAgain(panel);
    await expect(panel.getByTestId("claim-status")).toHaveText(/^Verified on \d{1,2} \w+ \d{4}$/);
    await expect(panel.getByTestId("claim-reason")).toHaveText(`Retrofit found the tag on http://${claimHostOf(CLAIM_HOST)}/.`);

    // Shown once: after a reload only the status remains, never the token.
    await page.reload();
    await expect(claimPanel(page, CLAIM_HOST).getByTestId("claim-status")).toHaveText(/^Verified on /);
    await expect(page.getByTestId("claim-token")).toHaveCount(0);
    expect(await page.content()).not.toContain(FIXTURE_CLAIM_TOKEN);
    await expect(page.getByRole("option", { name: new RegExp(claimHostOf(CLAIM_HOST).replaceAll(".", "\\.")) })).toHaveCount(0);

    const context = await browser.newContext();
    const other = await context.newPage();
    await signIn(other, newEmail("claims-meta-other"));
    await analyzeAny(other, CLAIM_HOST);
    const otherPanel = await claimSite(other, CLAIM_HOST, "meta");
    await checkAgain(otherPanel);
    await expect(otherPanel.getByTestId("claim-status")).toHaveText(/^Verified on /);
    await context.close();

    await page.reload();
    const moved = claimPanel(page, CLAIM_HOST);
    await expect(moved.getByTestId("claim-status")).toHaveText(/^Ownership moved to another account on \d{1,2} \w+ \d{4}\.$/);
    await expect(moved.getByRole("button", { name: CLAIMS_TEXT.checkAgain })).toHaveCount(0);
    await expect(moved.getByRole("button", { name: CLAIMS_TEXT.remove })).toBeEnabled();
  });

  // Fails if a robots-blocked site is read anyway or its owner is not pointed to DNS, or the DNS path with the
  // fixtures resolver does not verify.
  test("a robots-blocked site gets the DNS hint, and the DNS record verifies it", async ({ page }) => {
    await signIn(page, newEmail("claims-dns"));
    await analyzeAny(page, BLOCKED_HOST);
    const panel = await claimSite(page, BLOCKED_HOST, "meta");
    await checkAgain(panel);
    await expect(panel.getByTestId("claim-reason")).toHaveText("Your robots.txt blocks RetrofitBot, so Retrofit cannot read the tag. Use the DNS method instead.");
    await expect(panel.getByTestId("claim-status")).toHaveText(CLAIMS_TEXT.status.pending);

    await panel.getByRole("button", { name: CLAIMS_TEXT.useDns }).click();
    await expect(panel.getByTestId("claim-message")).toHaveText(CLAIMS_TEXT.restarted);
    await expect(panel.getByTestId("claim-token")).toContainText(CLAIMS_TEXT.addRecord("_retrofit-verification.blocked.fixture.test"));
    await expect(panel.getByTestId("claim-token").locator("code")).toHaveText(CLAIMS_TEXT.txtValue(FIXTURE_CLAIM_TOKEN));
    await checkAgain(panel);
    await expect(panel.getByTestId("claim-status")).toHaveText(/^Verified on /);
    await expect(panel.getByTestId("claim-reason")).toHaveText("Retrofit found the record at _retrofit-verification.blocked.fixture.test.");
  });

  // Fails if the recheck runs without its secret, a claim lapses before three failed daily rechecks or not after
  // them, the owner does not see the paused text, or one passing check does not restore it.
  test("three failed daily rechecks lapse a claim, and one passing check restores it", async ({ page, request }) => {
    expect((await request.get("/api/cron/claims")).status()).toBe(401);
    await signIn(page, newEmail("claims-lapse"));
    await analyzeAny(page, FLAKY_HOST);
    const panel = await claimSite(page, FLAKY_HOST, "meta");
    await checkAgain(panel);
    await expect(panel.getByTestId("claim-status")).toHaveText(/^Verified on /);

    await lapseFlaky(request);
    await page.goto("/account");
    const lapsed = claimPanel(page, FLAKY_HOST);
    await expect(lapsed.getByTestId("claim-status")).toHaveText(/^Verification failed on \d{1,2} \w+ \d{4}\. Your published page and badge are paused\.$/);
    await expect(lapsed.getByTestId("claim-reason")).toContainText("found no retrofit-site-verification tag");

    await setFlakyTag(request, true);
    await checkAgain(lapsed);
    await expect(lapsed.getByTestId("claim-status")).toHaveText(/^Verified on /);
    // A later recheck the same day changes nothing: the claim was just checked.
    expect((await runRecheck(request)).lapsed).toBe(0);
  });
});
