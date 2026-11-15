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
});
