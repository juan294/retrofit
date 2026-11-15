import { test, expect } from "./fixtures/csp";
import { fixtureOrigin } from "./support/global-setup";

test("a visitor pastes the bakery URL, sees progress, then the score and evidence", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Your website address").fill(fixtureOrigin("bakery.fixture.test"));
  await page.getByRole("button", { name: "Score my site" }).click();
  await expect(page).toHaveURL(/\/r\/[0-9a-f]{32}$/);
  await expect(page.getByTestId("analysis-progress")).toBeVisible();
  await expect(page.getByTestId("score-total")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("score-total")).toHaveText(/^\d+$/);
  await expect(page.getByRole("heading", { name: "Agentic web" })).toBeVisible();
  await expect(page.getByText("WebMCP: not checked")).toBeVisible();
  const row = page.getByTestId("check-read.server-text");
  await expect(row).toContainText("pass");
});

test("the landing page links to the RetrofitBot page through client navigation", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "How RetrofitBot reads your site" }).click();
  await expect(page).toHaveURL(/\/bot$/);
  await expect(page.getByRole("heading", { level: 1, name: "RetrofitBot" })).toBeVisible();
});
