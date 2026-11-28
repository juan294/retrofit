// Retrofit's public pricing, privacy and terms pages in production: each serves its heading, the
// pricing page shows the notify form with its privacy link (before billing starts, and after it while no
// plan has a price) or the plans with their price and upgrade button, and sitemap.xml lists all three. It
// sends no signup and opens no checkout (the production list stays free of test addresses).
import { test, expect } from "./fixtures/csp";
import { billingMayHaveStarted } from "./support/billing-start.mjs";
import { prodUrl } from "./support/report";

const PAGES = [
  ["/pricing", "Pricing"],
  ["/privacy", "Privacy"],
  ["/terms", "Terms"],
] as const;

test("the pricing, privacy and terms pages serve and are in the sitemap", async ({ page, request, evidence }) => {
  evidence.case("own-pages");
  for (const [path, heading] of PAGES) {
    const res = await page.goto(path);
    expect(res?.status(), path).toBe(200);
    await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
  }
  await page.goto("/pricing");
  // Until the earliest start by date, and as long as the page itself says it is free, the notify form is required.
  const free = (await page.getByText("Free during the hackathon judging period").count()) > 0;
  if (!billingMayHaveStarted()) expect(free, "the free notice stays until the earliest start").toBe(true);
  const upgrades = page.getByRole("button", { name: /^Upgrade to / });
  const notify = free || (await upgrades.count()) === 0;
  if (notify) {
    await expect(page.getByRole("button", { name: "Notify me" })).toBeEnabled();
    await expect(page.getByRole("link", { name: "privacy notice" })).toHaveAttribute("href", "/privacy");
    await expect(upgrades).toHaveCount(0);
  } else {
    // Every upgrade stands beside its price.
    for (const button of await upgrades.all()) {
      await expect(button).toBeEnabled();
      await expect(page.getByRole("listitem").filter({ has: button }).locator('[data-testid^="price-"]')).toHaveText(/\d/);
    }
  }
  const sitemap = await request.get("/sitemap.xml");
  expect(sitemap.status()).toBe(200);
  const xml = await sitemap.text();
  const origin = new URL(prodUrl()).origin;
  for (const [path] of PAGES) expect(xml, path).toContain(`<loc>${origin}${path}</loc>`);
  evidence.record({ pages: PAGES.map(([path]) => path), billing: notify ? "notify" : "upgrades" });
});
