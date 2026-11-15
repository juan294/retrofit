import { test, expect } from "./fixtures/csp";

const VIOLATION = { directive: "img-src", blockedURI: "http://blocked.fixture.test:3013/pixel.png" };

test("an unknown path renders the not-found page with the nonce CSP and no violation", async ({ page }) => {
  const response = await page.goto("/no-such-page.html");
  expect(response?.status()).toBe(404);
  expect(response?.headers()["content-security-policy"]).toMatch(/script-src 'self' 'nonce-/);
  await page.waitForLoadState("networkidle");
});

test.describe("CSP fixture", () => {
  // The fixture must fail a test that causes a violation it did not declare.
  // The test body succeeds, so the only failure left is the fixture's teardown check.
  test("fails without an expectation", async ({ page, cspViolations }) => {
    test.fail();
    await page.goto("/test-fixtures/csp-violation");
    await expect(page.getByText("CSP fixture")).toBeVisible();
    await expect.poll(() => [...new Set(cspViolations.map((v) => `${v.directive} ${v.blockedURI}`))]).toEqual([`${VIOLATION.directive} ${VIOLATION.blockedURI}`]);
  });

  test("passes with the exact expectation", async ({ page, expectCspViolations }) => {
    expectCspViolations([VIOLATION]);
    await page.goto("/test-fixtures/csp-violation");
    await expect(page.getByText("CSP fixture")).toBeVisible();
  });

  // The fixture must fail when a declared violation never happens.
  test("fails when an expected violation does not occur", async ({ page, expectCspViolations, cspViolations }) => {
    test.fail();
    expectCspViolations([VIOLATION]);
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Retrofit" })).toBeVisible();
    await page.waitForLoadState("networkidle");
    expect(cspViolations).toEqual([]);
  });

  // V12: the fixture watched only its own page. A violation in another tab of the test's context,
  // or in a context the test creates, must fail the test too. Each body first proves the monitor saw
  // the violation (as the first case above does), so the body passes and only the fixture can fail it.
  test("fails on a violation in a second tab", async ({ page, context, cspViolations }) => {
    test.fail();
    await page.goto("/");
    const tab = await context.newPage();
    await tab.goto("/test-fixtures/csp-violation");
    await expect(tab.getByText("CSP fixture")).toBeVisible();
    await tab.waitForLoadState("networkidle");
    await expect.poll(() => [...new Set(cspViolations.map((v) => `${v.directive} ${v.blockedURI}`))]).toEqual([`${VIOLATION.directive} ${VIOLATION.blockedURI}`]);
  });

  test("fails on a violation in a second browser context", async ({ page, browser, cspViolations }) => {
    test.fail();
    await page.goto("/");
    const other = await browser.newContext();
    const tab = await other.newPage();
    await tab.goto("/test-fixtures/csp-violation");
    await expect(tab.getByText("CSP fixture")).toBeVisible();
    await tab.waitForLoadState("networkidle");
    await expect.poll(() => [...new Set(cspViolations.map((v) => `${v.directive} ${v.blockedURI}`))]).toEqual([`${VIOLATION.directive} ${VIOLATION.blockedURI}`]);
    await other.close();
  });

  test("fails on a violation in a page opened with browser.newPage", async ({ browser, cspViolations }) => {
    test.fail();
    const tab = await browser.newPage();
    await tab.goto("/test-fixtures/csp-violation");
    await expect(tab.getByText("CSP fixture")).toBeVisible();
    await tab.waitForLoadState("networkidle");
    await expect.poll(() => [...new Set(cspViolations.map((v) => `${v.directive} ${v.blockedURI}`))]).toEqual([`${VIOLATION.directive} ${VIOLATION.blockedURI}`]);
    await tab.close();
  });

  // The positive controls: the exact expectation accepts the same violations from those pages.
  test("passes with the exact expectation for a violation in a second tab and a second context", async ({ context, browser, expectCspViolations }) => {
    expectCspViolations([VIOLATION]);
    const tab = await context.newPage();
    await tab.goto("/test-fixtures/csp-violation");
    await expect(tab.getByText("CSP fixture")).toBeVisible();
    const other = await browser.newContext();
    const otherTab = await other.newPage();
    await otherTab.goto("/test-fixtures/csp-violation");
    await expect(otherTab.getByText("CSP fixture")).toBeVisible();
  });

  test("passes with the exact expectation for a violation in a page opened with browser.newPage", async ({ browser, expectCspViolations }) => {
    expectCspViolations([VIOLATION]);
    const tab = await browser.newPage();
    await tab.goto("/test-fixtures/csp-violation");
    await expect(tab.getByText("CSP fixture")).toBeVisible();
  });
});
