import { test, expect } from "./fixtures/csp";
import { CLAIMS_TEXT } from "@/lib/site/claims-texts";
import { PLAN_TEXT } from "@/lib/site/plan-texts";
import { newEmail, signIn } from "./support/account";
import {
  addClaimTag,
  analyzeAny,
  BLOCKED_HOST,
  CLAIM_HOST,
  claimHostOf,
  claimPanel,
  claimSite,
  checkAgain,
  FLAKY_HOST,
  lapseFlaky,
  MISSING_HOST,
  publishTxt,
  runRecheck,
  setClockOffset,
  shownToken,
  verifyByTag,
  panelButton,
} from "./support/claims";

// Ownership claims (phase-3.md; parent success criterion 4). Each spec reads the token from the account page and
// publishes it: the fixture server puts the tag on claim.fixture.test or flaky.fixture.test, and the fixtures TXT
// store answers the DNS record.
test.describe("ownership claims", () => {
  test.afterEach(async ({ request }) => {
    await setClockOffset(request, 0);
  });

  // Fails if a claim by meta tag does not verify, the token shows again after a reload, or a second account's
  // verification does not move the host to it with the moved text for the first account.
  test("claim a fixture site by meta tag, see it verified, and see it move to a second account", async ({ page, browser }) => {
    await signIn(page, newEmail("claims-meta"));
    await analyzeAny(page, CLAIM_HOST);
    const { panel, token } = await claimSite(page, CLAIM_HOST, "meta");
    await expect(panel.getByTestId("claim-token").locator("code")).toHaveText(CLAIMS_TEXT.metaTag(token));
    await expect(panel.getByTestId("claim-status")).toHaveText(CLAIMS_TEXT.status.pending);
    await addClaimTag(page.request, CLAIM_HOST, token);
    await checkAgain(panel);
    await expect(panel.getByTestId("claim-status")).toHaveText(/^Verified on \d{1,2} \w+ \d{4}$/);
    await expect(panel.getByTestId("claim-reason")).toHaveText(`Retrofit found the tag on http://${claimHostOf(CLAIM_HOST)}/.`);

    // Shown once: after a reload only the status remains, never the token.
    await page.reload();
    await expect(claimPanel(page, CLAIM_HOST).getByTestId("claim-status")).toHaveText(/^Verified on /);
    await expect(page.getByTestId("claim-token")).toHaveCount(0);
    expect(await page.content()).not.toContain(token);
    await expect(page.getByRole("option", { name: new RegExp(claimHostOf(CLAIM_HOST).replaceAll(".", "\\.")) })).toHaveCount(0);

    const context = await browser.newContext();
    const other = await context.newPage();
    await signIn(other, newEmail("claims-meta-other"));
    await analyzeAny(other, CLAIM_HOST);
    const second = await claimSite(other, CLAIM_HOST, "meta");
    expect(second.token).not.toBe(token);
    await addClaimTag(other.request, CLAIM_HOST, second.token);
    await checkAgain(second.panel);
    await expect(second.panel.getByTestId("claim-status")).toHaveText(/^Verified on /);
    await context.close();

    await page.reload();
    const moved = claimPanel(page, CLAIM_HOST);
    await expect(moved.getByTestId("claim-status")).toHaveText(/^Ownership moved to another account on \d{1,2} \w+ \d{4}\.$/);
    await expect(panelButton(moved, CLAIMS_TEXT.checkAgain)).toHaveCount(0);
    await expect(panelButton(moved, CLAIMS_TEXT.remove)).toBeEnabled();
  });

  // UX-M1 and UX-M2. Fails if one click ends a verified claim, the second step does not take and give back the keyboard focus, the removal's
  // message goes with its panel, the focus is lost, or a pending claim needs a second step.
  test("Remove of a verified claim asks first, by keyboard, and its message stays", async ({ page }) => {
    test.setTimeout(90_000);
    await signIn(page, newEmail("claims-remove"));
    await analyzeAny(page, CLAIM_HOST);
    await analyzeAny(page, MISSING_HOST);
    await verifyByTag(page, CLAIM_HOST);
    await claimSite(page, MISSING_HOST, "meta");
    const panel = claimPanel(page, CLAIM_HOST);
    let removals = 0;
    page.on("request", (r) => void (r.url().endsWith("/api/claims/remove") && removals++));
    const remove = panelButton(panel, CLAIMS_TEXT.remove);
    await remove.focus();
    await page.keyboard.press("Enter");
    const step = panel.getByTestId("second-step");
    await expect(step).toBeFocused();
    await expect(step).toContainText(CLAIMS_TEXT.removeQuestion(claimHostOf(CLAIM_HOST), false));
    await panelButton(panel, CLAIMS_TEXT.removeCancel).click();
    await expect(remove).toBeFocused();
    expect(removals).toBe(0);
    await page.keyboard.press("Enter");
    await page.keyboard.press("Tab");
    await expect(panelButton(panel, CLAIMS_TEXT.removeConfirm)).toBeFocused();
    await page.keyboard.press("Enter");
    const message = page.getByTestId("claims-message");
    await expect(message).toHaveText(`${claimHostOf(CLAIM_HOST)}: ${CLAIMS_TEXT.removed}`);
    await expect(panel).toHaveCount(0);
    await expect(page.getByRole("heading", { level: 2, name: CLAIMS_TEXT.heading })).toBeFocused();
    // The removed site can be claimed again once the page read the server data again; the message is still there.
    await expect(page.getByRole("option", { name: CLAIMS_TEXT.sourceFromAnalysis(claimHostOf(CLAIM_HOST)) })).toHaveCount(1);
    await expect(message).toHaveText(`${claimHostOf(CLAIM_HOST)}: ${CLAIMS_TEXT.removed}`);

    await panelButton(claimPanel(page, MISSING_HOST), CLAIMS_TEXT.remove).click();
    await expect(message).toHaveText(`${claimHostOf(MISSING_HOST)}: ${CLAIMS_TEXT.removed}`);
    expect(removals).toBe(2);
  });

  // UX-H1. Fails if a signed-out answer in a panel has no way to sign in, or sign-in does not return to the account.
  test("a claim action after sign-out links to sign-in", async ({ page }) => {
    await signIn(page, newEmail("claims-401"));
    await analyzeAny(page, MISSING_HOST);
    await page.goto("/account");
    await page.context().clearCookies({ name: "retrofit_account" });
    await page.getByRole("button", { name: CLAIMS_TEXT.claimButton }).click();
    await expect(page.getByTestId("claims-message")).toContainText(CLAIMS_TEXT.signedOut);
    await expect(page.getByTestId("claims-message").getByRole("link", { name: PLAN_TEXT.signIn })).toHaveAttribute("href", "/sign-in?returnTo=%2Faccount");
  });

  // Fails if a robots-blocked site is read anyway or its owner is not pointed to DNS, or the DNS path through the
  // fixtures TXT store does not verify.
  test("a robots-blocked site gets the DNS hint, and the DNS record verifies it", async ({ page }) => {
    await signIn(page, newEmail("claims-dns"));
    await analyzeAny(page, BLOCKED_HOST);
    const { panel } = await claimSite(page, BLOCKED_HOST, "meta");
    await checkAgain(panel);
    await expect(panel.getByTestId("claim-reason")).toHaveText("Your robots.txt blocks RetrofitBot, so Retrofit cannot read the tag. Use the DNS method instead.");
    await expect(panel.getByTestId("claim-status")).toHaveText(CLAIMS_TEXT.status.pending);

    await panelButton(panel, CLAIMS_TEXT.useDns).click();
    await expect(panel.getByTestId("claim-message")).toHaveText(`${CLAIMS_TEXT.restarted} ${CLAIMS_TEXT.addShown.dns}`);
    await expect(panel.getByTestId("claim-token")).toContainText(CLAIMS_TEXT.addRecord("_retrofit-verification.blocked.fixture.test"));
    const token = await shownToken(panel);
    await expect(panel.getByTestId("claim-token").locator("code")).toHaveText(CLAIMS_TEXT.txtValue(token));
    await checkAgain(panel);
    await expect(panel.getByTestId("claim-reason")).toContainText("found no TXT record at _retrofit-verification.blocked.fixture.test");
    await publishTxt(page.request, BLOCKED_HOST, token);
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
    const { panel, token } = await claimSite(page, FLAKY_HOST, "meta");
    await addClaimTag(request, FLAKY_HOST, token);
    await checkAgain(panel);
    await expect(panel.getByTestId("claim-status")).toHaveText(/^Verified on /);

    await lapseFlaky(request);
    await page.goto("/account");
    const lapsed = claimPanel(page, FLAKY_HOST);
    await expect(lapsed.getByTestId("claim-status")).toHaveText(/^Verification failed on \d{1,2} \w+ \d{4}\.$/);
    await expect(lapsed.getByTestId("claim-reason")).toContainText("found no retrofit-site-verification tag");

    await addClaimTag(request, FLAKY_HOST, token);
    await checkAgain(lapsed);
    await expect(lapsed.getByTestId("claim-status")).toHaveText(/^Verified on /);
    // A later recheck the same day changes nothing: the claim was just checked.
    expect((await runRecheck(request)).lapsed).toBe(0);
  });
});
