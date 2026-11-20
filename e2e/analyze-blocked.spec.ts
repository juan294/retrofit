import { test, expect } from "./fixtures/csp";
import { fixtureOrigin } from "./support/global-setup";

test("a site that blocks RetrofitBot shows the robots message and no score", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Your website address").fill(fixtureOrigin("blocked.fixture.test"));
  await page.getByRole("button", { name: "Score my site" }).click();
  await expect(page).toHaveURL(/\/r\/[0-9a-f]{32}$/);
  await expect(page.getByText("This site asks automated tools not to read it. Retrofit stopped and read nothing else.")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("score-total")).toHaveCount(0);
});
