import type { Locator } from "@playwright/test";
import { test, expect } from "./fixtures/csp";
import { analyzeFixture, mockOtari } from "./support/agent";

/**
 * WCAG contrast of a text element against the first opaque background behind it.
 * The vendored runtime has light colors built in, so its panel must stay readable when the page is dark.
 */
async function contrastOf(el: Locator): Promise<{ ratio: number; color: string; background: string }> {
  return el.evaluate((node) => {
    const parse = (c: string) => {
      const m = c.match(/rgba?\(([^)]+)\)/);
      if (!m) return null;
      const [r, g, b, a = "1"] = m[1].split(/[ ,/]+/).filter(Boolean);
      return { r: Number(r), g: Number(g), b: Number(b), a: Number(a) };
    };
    const luminance = ({ r, g, b }: { r: number; g: number; b: number }) => {
      const lin = (v: number) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    };
    const color = getComputedStyle(node as Element).color;
    let background = "";
    for (let cur: Element | null = node as Element; cur; cur = cur.parentElement) {
      const bg = getComputedStyle(cur).backgroundColor;
      const parsed = parse(bg);
      // A format the parser cannot read (color(), oklch()) must fail the test, never be skipped as transparent.
      if (!parsed) throw new Error(`Unparsed background: ${bg}`);
      if (parsed.a >= 1) {
        background = bg;
        break;
      }
    }
    const fg = parse(color);
    const back = parse(background || "rgb(255, 255, 255)");
    if (!fg || !back) throw new Error(`Unparsed colors: ${color} on ${background}`);
    const [hi, lo] = [luminance(fg), luminance(back)].sort((x, y) => y - x);
    return { ratio: (hi + 0.05) / (lo + 0.05), color, background };
  });
}

for (const colorScheme of ["light", "dark"] as const) {
  test(`the preview's runtime text is readable in ${colorScheme} mode`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    await mockOtari(page);
    await analyzeFixture(page, "bakery.fixture.test");
    const mount = page.getByTestId("preview-mount");
    const targets = {
      title: mount.locator(".ns-title").first(),
      actions: mount.getByText(/website actions? connected/).first(),
      greeting: mount.getByText(/^Private preview of /).first(),
    };
    for (const [name, el] of Object.entries(targets)) {
      await expect(el, name).toBeVisible();
      const { ratio, color, background } = await contrastOf(el);
      expect(ratio, `${name}: ${color} on ${background}`).toBeGreaterThanOrEqual(4.5);
    }
  });
}
