import { test, expect } from "./fixtures/csp";
import { ACCOUNT_TEXT, SAVE_REPORT_TEXT } from "@/lib/site/account-texts";
import { SIGN_IN_TEXT } from "@/lib/site/sign-in-texts";
import { BASE_URL } from "../playwright.config";
import { askForLink, newEmail, openLink, signIn } from "./support/account";
import { analyzeFixture } from "./support/agent";

// This spec runs before analyze.spec.ts, which needs bakery's first crawl (it watches the progress state), so it
// analyzes a fixture site no earlier spec uses.
const SITE = "agentified.fixture.test";

test.describe("accounts", () => {
  // Fails if any step of the account path breaks: the link returns to the results page, the report saves and
  // opens read-only from the account page, the attached analysis opens on another browser with the account
  // alone, sign-out ends the session, a used link shows the send-again page, and deletion removes the account.
  test("sign in from a results page, save the report, open it from the account page, sign out, and delete the account", async ({ page, browser }) => {
    const email = newEmail("path");
    const id = await analyzeFixture(page, SITE);
    await page.getByRole("link", { name: SAVE_REPORT_TEXT.signIn }).click();
    await expect(page).toHaveURL(new RegExp(`/sign-in\\?returnTo=%2Fr%2F${id}$`));
    await expect(page.getByRole("button", { name: SIGN_IN_TEXT.submit })).toBeEnabled();

    const link = await askForLink(page, email);
    await expect(page.getByRole("button", { name: SIGN_IN_TEXT.sendAgain })).toBeVisible();
    // Opening the link (as a mail scanner would) verifies nothing and sets no cookie.
    const scanned = await page.request.get(link);
    expect(scanned.status()).toBe(200);
    expect(scanned.headers()["set-cookie"]).toBeUndefined();
    expect(scanned.headers()["referrer-policy"]).toBe("no-referrer");
    expect(scanned.headers()["cache-control"]).toContain("no-store");
    await openLink(page, link);
    await expect(page).toHaveURL(new RegExp(`/r/${id}$`));
    await expect(page.getByTestId("score-total")).toBeVisible({ timeout: 30_000 });

    await page.getByRole("button", { name: SAVE_REPORT_TEXT.button }).click();
    await expect(page.getByTestId("save-report").getByRole("status")).toContainText(SAVE_REPORT_TEXT.saved);
    await page.getByRole("link", { name: SAVE_REPORT_TEXT.openAccount }).click();
    await expect(page).toHaveURL(/\/account$/);
    await expect(page.getByTestId("account-email")).toHaveText(email);
    const saved = page.getByTestId("saved-reports").getByRole("link", { name: new RegExp(SITE.replaceAll(".", "\\.")) });
    await saved.click();
    await expect(page).toHaveURL(/\/account\/reports\/[0-9a-f-]{36}$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(new RegExp(`^Saved report: ${SITE.replaceAll(".", "\\.")}`));
    await expect(page.getByTestId("score-total")).toBeVisible();
    await expect(page.getByTestId("preview-mount")).toHaveCount(0);

    // The analysis is attached to the account: another browser with only the account cookie opens it.
    const account = (await page.context().cookies()).find((c) => c.name === "retrofit_account");
    expect(account?.httpOnly).toBe(true);
    const other = await browser.newContext();
    await other.addCookies([{ name: "retrofit_account", value: account!.value, url: BASE_URL }]);
    const otherPage = await other.newPage();
    await otherPage.goto(`/r/${id}`);
    await expect(otherPage.getByTestId("score-total")).toBeVisible({ timeout: 30_000 });
    await other.close();

    await page.goto("/account");
    await page.getByRole("button", { name: ACCOUNT_TEXT.signOut }).click();
    await expect(page).toHaveURL(`${BASE_URL}/`);
    await page.goto("/account");
    await expect(page).toHaveURL(/\/sign-in\?returnTo=%2Faccount$/);

    // The used link shows the expired page with the send-again form.
    await openLink(page, link);
    await expect(page).toHaveURL(/\/sign-in\?link=expired$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(SIGN_IN_TEXT.expiredTitle);
    await expect(page.getByLabel("Email")).toHaveValue("");

    await signIn(page, email);
    await page.getByRole("checkbox", { name: ACCOUNT_TEXT.deleteConfirm }).check();
    await page.getByRole("button", { name: ACCOUNT_TEXT.deleteButton }).click();
    await expect(page).toHaveURL(/\/sign-in\?account=deleted$/);
    await expect(page.getByRole("status")).toHaveText(SIGN_IN_TEXT.deleted);
    expect((await page.context().cookies()).some((c) => c.name === "retrofit_account")).toBe(false);
    await page.goto("/account");
    await expect(page).toHaveURL(/\/sign-in\?returnTo=%2Faccount$/);
  });

  // Fails if the address can reach a page URL (a GET form submission) before or after hydration.
  test("the sign-in form never puts the address in a URL", async ({ page }) => {
    const email = newEmail("url");
    const urls: string[] = [];
    page.on("request", (r) => void urls.push(r.url()));
    await page.goto("/sign-in");
    await askForLink(page, email);
    expect(urls.filter((u) => u.includes(encodeURIComponent(email)) && !u.includes("/test-fixtures/mailbox"))).toEqual([]);
    expect(urls.filter((u) => u.includes(email))).toEqual([]);
  });

  // Fails if a page served to a signed-out visitor offers saving, or a signed-in visitor's results page does not.
  test("the results page offers saving only when signed in", async ({ page }) => {
    const id = await analyzeFixture(page, SITE);
    await expect(page.getByRole("button", { name: SAVE_REPORT_TEXT.button })).toHaveCount(0);
    await signIn(page, newEmail("offer"), `/r/${id}`);
    await expect(page.getByTestId("score-total")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("button", { name: SAVE_REPORT_TEXT.button })).toBeEnabled();
    await expect(page.getByRole("link", { name: SAVE_REPORT_TEXT.signIn })).toHaveCount(0);
  });

  // P2-R1. Fails if a link opened in a browser that did not ask for it signs in without the warning, or attaches anything.
  test("a link opened in another browser warns before signing in and returns to the account page", async ({ page, browser }) => {
    const email = newEmail("other");
    await page.goto("/sign-in");
    const link = await askForLink(page, email);
    const other = await browser.newContext();
    const otherPage = await other.newPage();
    await otherPage.goto(link);
    await expect(otherPage.getByTestId("other-browser")).toHaveText(SIGN_IN_TEXT.otherBrowser);
    await otherPage.getByRole("button", { name: SIGN_IN_TEXT.confirmButton }).click();
    await expect(otherPage).toHaveURL(/\/account$/);
    await expect(otherPage.getByTestId("account-email")).toHaveText(email);
    await other.close();
    // The browser that asked sees no warning.
    await page.goto(link);
    await expect(page.getByRole("button", { name: SIGN_IN_TEXT.confirmButton })).toBeVisible();
    await expect(page.getByTestId("other-browser")).toHaveCount(0);
  });
});
