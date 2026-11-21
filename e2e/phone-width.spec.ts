import { test, expect } from "./fixtures/csp";

test.use({ viewport: { width: 320, height: 640 } });

// Pages with an agent panel wait for the free AI, so late content (key panel, preview) is measured too.
for (const [path, hasAgent] of [["/", true], ["/conformance", true], ["/bot", false]] as const) {
  test(`${path} fits a 320 px phone screen without sideways scrolling`, async ({ page }) => {
    await page.goto(path);
    if (hasAgent) await expect(page.getByText("Using Retrofit's free AI")).toBeVisible();
    else await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBe(0);
  });
}
