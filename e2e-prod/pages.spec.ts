// Retrofit's public pricing, privacy and terms pages in production: each serves its heading, the
// pricing page shows the notify form with its privacy link, and sitemap.xml lists all three. It
// sends no signup (the production list stays free of test addresses).
import { test, expect } from "./fixtures/csp";
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
  await expect(page.getByRole("button", { name: "Notify me" })).toBeEnabled();
  await expect(page.getByRole("link", { name: "privacy notice" })).toHaveAttribute("href", "/privacy");
  const sitemap = await request.get("/sitemap.xml");
  expect(sitemap.status()).toBe(200);
  const xml = await sitemap.text();
  const origin = new URL(prodUrl()).origin;
  for (const [path] of PAGES) expect(xml, path).toContain(`<loc>${origin}${path}</loc>`);
  evidence.record({ pages: PAGES.map(([path]) => path) });
});
