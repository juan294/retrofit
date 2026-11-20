import { test, expect } from "./fixtures/csp";

// Fails if the built site stops serving the discovery files and markup that Retrofit's own score checks.
test("Retrofit serves robots.txt, sitemap.xml, llms.txt, home JSON-LD and a contact link", async ({ page, request }) => {
  const robots = await request.get("/robots.txt");
  expect(robots.status()).toBe(200);
  expect(await robots.text()).toMatch(/^Sitemap: https?:\/\/\S+\/sitemap\.xml$/m);

  const sitemap = await request.get("/sitemap.xml");
  expect(sitemap.status()).toBe(200);
  expect(sitemap.headers()["content-type"]).toMatch(/xml/);
  expect(await sitemap.text()).toContain("<urlset");

  const llms = await request.get("/llms.txt");
  expect(llms.status()).toBe(200);
  expect(llms.headers()["content-type"]).toMatch(/^text\/plain/);
  expect(await llms.text()).toMatch(/^# Retrofit\n/);

  await page.goto("/");
  const ld = await page.locator('script[type="application/ld+json"]').allTextContents();
  const types = ld.flatMap((t) => [JSON.parse(t)].flat()).map((n: { "@type"?: string }) => n["@type"]);
  expect(types).toEqual(expect.arrayContaining(["Organization", "Service"]));
  await expect(page.getByRole("link", { name: /Contact/ })).toHaveAttribute("href", "https://github.com/juan294/retrofit/issues");
});
