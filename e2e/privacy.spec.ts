import { test, expect } from "./fixtures/csp";
import { fixtureOrigin } from "./support/global-setup";

const OTHER = "This preview belongs to another browser. Analyze the site again to get your own.";

test("two browsers analyze one URL and each sees only its own analysis", async ({ page, browser }) => {
  const url = fixtureOrigin("bakery.fixture.test");
  async function analyze(p: typeof page) {
    await p.goto("/");
    await p.getByLabel("Your website address").fill(url);
    await p.getByRole("button", { name: "Score my site" }).click();
    await expect(p).toHaveURL(/\/r\/[0-9a-f]{32}$/);
    return new URL(p.url()).pathname;
  }
  const pathA = await analyze(page);
  const contextB = await browser.newContext();
  const pageB = await contextB.newPage();
  const pathB = await analyze(pageB);
  expect(pathB).not.toBe(pathA);

  await expect(page.getByTestId("score-total")).toBeVisible({ timeout: 30_000 });
  const response = await pageB.goto(pathA);
  expect(response?.status()).toBe(404);
  await expect(pageB.getByText(OTHER)).toBeVisible();
  const status = await pageB.request.get(`/api/analyze/${pathA.split("/").pop()}`);
  expect(status.status()).toBe(404);
  expect((await status.json()).message).toBe(OTHER);
  await contextB.close();
});
