import { test, expect } from "./fixtures/csp";
import { analyzeFixture } from "./support/agent";
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

test("another browser gets the 404 text for every private preview file of an analysis", async ({ page, browser }) => {
  const id = await analyzeFixture(page, "bakery.fixture.test");

  // Context A, the owner, reads its manifest and finds the network file name there.
  const manifestA = await page.request.get(`/p/${id}/agent-manifest.json`);
  expect(manifestA.status()).toBe(200);
  const manifest = (await manifestA.json()) as { networks: { name: string; hocon: string }[] };
  const hocon = manifest.networks[0]!.hocon;
  expect(hocon).toMatch(/^\.\/[a-z0-9_]+\.network\.json$/);
  const networkFile = hocon.replace(/^\.\//, "");
  const files = ["agent-manifest.json", "site-content.json", networkFile];
  for (const file of files) {
    const own = await page.request.get(`/p/${id}/${file}`);
    expect(own.status(), `owner reads ${file}`).toBe(200);
  }

  // Context B has its own visitor cookie (it analyzed a site too) but is not the owner.
  const contextB = await browser.newContext();
  const pageB = await contextB.newPage();
  await analyzeFixture(pageB, "bakery.fixture.test");
  for (const file of files) {
    const other = await pageB.request.get(`/p/${id}/${file}`);
    expect(other.status(), `another browser reads ${file}`).toBe(404);
    expect(other.headers()["cache-control"]).toBe("private, no-store");
    const body = await other.text();
    expect(JSON.parse(body).message, `404 text for ${file}`).toBe(OTHER);
    // Nothing of the private file leaks into the refusal.
    expect(body).not.toContain("bakery");
  }
  await contextB.close();
});
