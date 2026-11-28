import { test, expect } from "./fixtures/csp";

// Fails if a page loses a browser icon, the manifest or the theme colour, or if one of them does not load.
test("the page head names the icons, the manifest and the theme colour, and each one loads", async ({ page, request }) => {
  await page.goto("/");
  const head = page.locator("head");
  await expect(head.locator('meta[name="theme-color"]')).toHaveAttribute("content", "#f0f1f0");

  const links = await head.locator('link[rel="icon"], link[rel="apple-touch-icon"], link[rel="manifest"]').evaluateAll((els) =>
    els.map((el) => ({ rel: el.getAttribute("rel"), href: el.getAttribute("href") ?? "", type: el.getAttribute("type") })),
  );
  const hrefs = links.map((l) => `${l.rel} ${l.href.split("?")[0] ?? ""}`);
  expect(hrefs).toEqual(expect.arrayContaining(["icon /favicon.ico", "icon /icon.svg", "apple-touch-icon /apple-icon.png", "manifest /manifest.webmanifest"]));

  const types: Record<string, string> = { "/favicon.ico": "image/x-icon", "/icon.svg": "image/svg+xml", "/apple-icon.png": "image/png", "/manifest.webmanifest": "application/manifest+json" };
  for (const { href } of links) {
    const path = href.split("?")[0] ?? href;
    const res = await request.get(href);
    expect(res.status(), href).toBe(200);
    expect(res.headers()["content-type"], href).toContain(types[path]);
  }

  const manifest = (await (await request.get("/manifest.webmanifest")).json()) as { icons: { src: string }[] };
  for (const { src } of manifest.icons) {
    const res = await request.get(src);
    expect(res.status(), src).toBe(200);
    expect(res.headers()["content-type"], src).toBe("image/png");
  }
});
