import { test, expect } from "./fixtures/csp";
import { analyzeFixture } from "./support/agent";
import { fits } from "./support/layout";

// The Field Inspection design (docs/plans/2026-11-26-field-inspection-ui.md). Phase 1: fonts, the fixed theme and the states that could leave a visitor stuck.

type Page = import("@playwright/test").Page;

const INK = "rgb(14, 14, 14)";
const PAPER = "rgb(240, 241, 240)";

/** The first family of the element's computed font: the name next/font generated. */
const firstFamily = (page: Page, selector: string) =>
  page.evaluate((s) => getComputedStyle(document.querySelector(s)!).fontFamily.split(",")[0]!.trim(), selector);

// Fails if a font comes from another host (the page policy has font-src 'self'), or if a face never loads.
test("both font families load from Retrofit's own origin", async ({ page, baseURL }) => {
  const origin = new URL(baseURL!).origin;
  const fonts: { url: string; status: number }[] = [];
  page.on("response", (r) => {
    if (r.request().resourceType() === "font") fonts.push({ url: r.url(), status: r.status() });
  });
  await page.goto("/");
  await page.evaluate(() => document.fonts.ready);
  expect(fonts.length).toBeGreaterThanOrEqual(2);
  for (const f of fonts) {
    expect(new URL(f.url).origin, f.url).toBe(origin);
    expect(f.status, f.url).toBe(200);
  }
  // The address field uses the mono family; the body uses the text family.
  const body = await firstFamily(page, "body");
  const mono = await firstFamily(page, "#site-url");
  expect(mono).not.toBe(body);
  const loaded = await page.evaluate(() => [...document.fonts].filter((f) => f.status === "loaded").map((f) => f.family));
  const bare = (family: string) => family.replace(/^["']|["']$/g, "");
  expect(loaded.map(bare)).toEqual(expect.arrayContaining([bare(body), bare(mono)]));
});

// Fails if the display face is not the variable font with a width axis: a fallback or a fixed-width file
// renders the same width at 62% and at 100%, and every display heading then overflows its design.
test("the display face is really condensed at 62% width", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => document.fonts.ready);
  const [narrow, normal] = await page.evaluate(() => {
    const family = getComputedStyle(document.body).fontFamily;
    const width = (stretch: string) => {
      const el = document.createElement("span");
      el.textContent = "AGENT READINESS INSPECTION";
      el.style.cssText = `position:absolute;white-space:nowrap;font-family:${family};font-weight:900;font-size:40px;font-stretch:${stretch}`;
      document.body.append(el);
      const w = el.getBoundingClientRect().width;
      el.remove();
      return w;
    };
    return [width("62%"), width("100%")];
  });
  expect(normal).toBeGreaterThan(100);
  expect(narrow).toBeLessThan(normal! * 0.75);
});

// Decision D2. Fails if a dark system changes any page colour.
for (const colorScheme of ["light", "dark"] as const) {
  test(`the page is ink on paper when the system is in ${colorScheme} mode`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    await page.goto("/pricing");
    const body = await page.evaluate(() => {
      const s = getComputedStyle(document.body);
      return { color: s.color, background: s.backgroundColor };
    });
    expect(body).toEqual({ color: INK, background: PAPER });
  });
}

// Stuck state: forced colours remove fills. Fails if a control is then left without an edge, or a link without a mark.
test("with forced colours the address form and the navigation stay usable", async ({ page }) => {
  await page.emulateMedia({ forcedColors: "active" });
  await page.goto("/");
  const field = page.getByLabel("Your website address");
  const button = page.getByRole("button", { name: "Score my site" });
  for (const el of [field, button]) {
    await expect(el).toBeVisible();
    expect(await el.evaluate((n) => parseFloat(getComputedStyle(n).borderTopWidth))).toBeGreaterThanOrEqual(1);
  }
  for (const name of ["Pricing", "Account"]) {
    const link = page.getByRole("navigation", { name: "Retrofit" }).getByRole("link", { name });
    await expect(link).toBeVisible();
    expect(await link.evaluate((n) => getComputedStyle(n).textDecorationLine)).toContain("underline");
  }
});

// Stuck state: a font file does not load. Fails if the fallback fonts push a page wider than a 320 px screen.
test.describe("without the font files", () => {
  test.use({ viewport: { width: 320, height: 640 } });

  test("the home page and a report still fit a 320 px screen", async ({ page }) => {
    let aborted = 0;
    await page.route("**/*.woff2", (route) => {
      aborted += 1;
      return route.abort();
    });
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByText("Using Retrofit's free AI")).toBeVisible();
    expect(aborted).toBeGreaterThanOrEqual(1);
    await fits(page);
    // The address field falls back to a system mono, never to a proportional face made to look like the mono one.
    const families = await page.evaluate(() => getComputedStyle(document.querySelector("#site-url")!).fontFamily.split(",").map((f) => f.trim()));
    expect(families[1]).toBe("ui-monospace");
    await analyzeFixture(page, "bakery.fixture.test");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByRole("link", { name: "Download the files" })).toBeVisible();
    await fits(page);
  });
});

// Stuck state: before the page's scripts run, the button is disabled. Fails if it then looks like an active
// button, or if its label is too faint to read.
test.describe("before hydration", () => {
  test.use({ javaScriptEnabled: false });

  test("the disabled address button is marked by its border and its label stays readable", async ({ page }) => {
    await page.goto("/");
    const button = page.getByRole("button", { name: "Score my site" });
    await expect(button).toBeDisabled();
    const style = await button.evaluate((n) => {
      const s = getComputedStyle(n);
      return { border: s.borderTopStyle, cursor: s.cursor, color: s.color, background: s.backgroundColor, opacity: s.opacity };
    });
    expect(style).toEqual({ border: "dashed", cursor: "not-allowed", color: INK, background: PAPER, opacity: "1" });
  });
});
