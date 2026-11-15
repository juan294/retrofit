import { test, expect } from "./fixtures/csp";

const VIOLATION = { directive: "img-src", blockedURI: "http://blocked.fixture.test:3013/pixel.png" };

test.describe("CSP fixture", () => {
  // The fixture must fail a test that causes a violation it did not declare.
  test("fails without an expectation", async ({ page }) => {
    test.fail();
    await page.goto("/test-fixtures/csp-violation");
    await expect(page.getByText("CSP fixture")).toBeVisible();
  });

  test("passes with the exact expectation", async ({ page, expectCspViolations }) => {
    expectCspViolations([VIOLATION]);
    await page.goto("/test-fixtures/csp-violation");
    await expect(page.getByText("CSP fixture")).toBeVisible();
  });

  // The fixture must fail when a declared violation never happens.
  test("fails when an expected violation does not occur", async ({ page, expectCspViolations }) => {
    test.fail();
    expectCspViolations([VIOLATION]);
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Retrofit" })).toBeVisible();
  });
});
