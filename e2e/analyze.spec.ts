import { test, expect } from "./fixtures/csp";
import { fixtureOrigin } from "./support/global-setup";

test("a visitor pastes the bakery URL, sees progress, then the score and evidence", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Your website address").fill(fixtureOrigin("bakery.fixture.test"));
  await page.getByRole("button", { name: "Score my site" }).click();
  await expect(page).toHaveURL(/\/r\/[0-9a-f]{32}$/);
  await expect(page.getByTestId("analysis-progress")).toBeVisible();
  await expect(page.getByTestId("score-total")).toBeVisible({ timeout: 30_000 });
  // UX-M2. Fails if the region that announced the progress does not announce the report.
  await expect(page.getByRole("status").filter({ hasText: "The report is ready." })).toHaveCount(1);
  await expect(page.getByTestId("score-total")).toHaveText(/^\d+$/);
  await expect(page.getByRole("heading", { name: "Agentic web" })).toBeVisible();
  await expect(page.getByText("WebMCP tools: not checked")).toBeVisible();
  const row = page.getByTestId("check-read.server-text");
  await expect(row).toContainText("pass");
  await expect(row).toContainText(/\d+ points/);
});

// Fails if the result page stops leading with what to fix, or orders it by anything but points lost.
test("the result page lists the heaviest failed checks first, each with a fix", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Your website address").fill(fixtureOrigin("bakery.fixture.test"));
  await page.getByRole("button", { name: "Score my site" }).click();
  await expect(page.getByTestId("score-total")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("score-passed")).toHaveText(/^\d+ of \d+ checks passed\.$/);
  const fixes = page.getByTestId("fix-first").getByRole("listitem");
  const failed = await page.locator('[data-testid^="check-"]').filter({ has: page.locator("strong", { hasText: /^fail$/ }) }).count();
  await expect(fixes).toHaveCount(Math.min(3, failed));
  const points = (await fixes.allTextContents()).map((t) => Number(/(\d+) points/.exec(t)?.[1]));
  expect(points).toEqual([...points].sort((a, b) => b - a));
  for (const t of await fixes.allTextContents()) expect(t).toMatch(/\.\s*\(\d+ points\)$/);
});

test("two tabs that read the first completed result both show the score", async ({ page, context }) => {
  await page.goto("/");
  await page.getByLabel("Your website address").fill(fixtureOrigin("bakery.fixture.test"));
  await page.getByRole("button", { name: "Score my site" }).click();
  await expect(page).toHaveURL(/\/r\/[0-9a-f]{32}$/);
  // A second tab of the same visitor polls the same analysis while it is still in progress.
  const second = await context.newPage();
  await second.goto(page.url());
  await expect(page.getByTestId("score-total")).toHaveText(/^\d+$/, { timeout: 30_000 });
  await expect(second.getByTestId("score-total")).toHaveText(/^\d+$/, { timeout: 30_000 });
  await expect(second.getByTestId("score-total")).toHaveText((await page.getByTestId("score-total").textContent()) ?? "");
});

test("the landing page links to the RetrofitBot page through client navigation", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "How RetrofitBot reads your site" }).click();
  await expect(page).toHaveURL(/\/bot$/);
  await expect(page.getByRole("heading", { level: 1, name: "RetrofitBot" })).toBeVisible();
});
