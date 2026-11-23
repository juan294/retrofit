import { test, expect } from "./fixtures/csp";
import { PRIVACY, TERMS } from "@/lib/site/legal-texts";
import { PRICING_TEXT, UNSUBSCRIBE_TEXT } from "@/lib/site/pricing-texts";
import { ACCOUNT_TEXT, SAVE_REPORT_TEXT, SAVED_REPORT_TEXT } from "@/lib/site/account-texts";
import { SIGN_IN_TEXT } from "@/lib/site/sign-in-texts";
import { newEmail, signIn } from "./support/account";
import { analyzeFixture, mockOtari } from "./support/agent";

type Locator = import("@playwright/test").Locator;

/**
 * WCAG contrast of a text element against the first opaque background behind it.
 * The vendored runtime has light colors built in, so its panel must stay readable when the page is dark.
 */
async function contrastOf(el: Locator): Promise<{ ratio: number; color: string; background: string }> {
  return el.evaluate((node) => {
    const parse = (c: string) => {
      const m = c.match(/^rgba?\(([^)]+)\)$/);
      const parts = m?.[1]?.split(/[ ,/]+/).filter(Boolean).map(Number) ?? [];
      if (parts.length < 3 || parts.some(Number.isNaN)) return null;
      const [r = 0, g = 0, b = 0, a = 1] = parts;
      return { r, g, b, a };
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
    const [l1, l2] = [luminance(fg), luminance(back)];
    return { ratio: (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05), color, background };
  });
}

for (const colorScheme of ["light", "dark"] as const) {
  test(`the preview's runtime text is readable in ${colorScheme} mode`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    await mockOtari(page);
    await analyzeFixture(page, "bakery.fixture.test");
    const mount = page.getByTestId("preview-mount");
    const targets = {
      email: page.getByRole("link", { name: "Email retrofit@thecreativetoken.com" }),
      download: page.getByRole("link", { name: "Download the files" }),
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

type Page = import("@playwright/test").Page;

// The pricing, privacy, terms and unsubscribe pages (confirm and invalid-link states) use the page tokens only;
// every text kind on them must stay readable in both schemes. Each page adds its own targets to the shared ones.
const TEXT_PAGES: Record<string, (page: Page) => Record<string, Locator>> = {
  "/pricing": (page) => ({
    text: page.getByText(PRICING_TEXT.intro),
    notice: page.getByText(PRICING_TEXT.freeNotice),
    plan: page.getByRole("heading", { level: 2, name: "Pro", exact: true }),
    button: page.getByRole("button", { name: "Notify me" }),
    privacy: page.getByRole("link", { name: "privacy notice" }),
  }),
  "/privacy": (page) => ({ text: page.getByText(PRIVACY.intro) }),
  "/terms": (page) => ({ text: page.getByText(TERMS.intro) }),
  "/unsubscribe?t=0123456789abcdef0123456789abcdef": (page) => ({
    text: page.getByText(UNSUBSCRIBE_TEXT.confirm),
    button: page.getByRole("button", { name: UNSUBSCRIBE_TEXT.confirmButton }),
  }),
  "/unsubscribe?t=not-a-token": (page) => ({ text: page.getByText(UNSUBSCRIBE_TEXT.invalid) }),
  "/sign-in": (page) => ({
    text: page.getByText(SIGN_IN_TEXT.intro),
    button: page.getByRole("button", { name: SIGN_IN_TEXT.submit }),
    privacy: page.getByRole("link", { name: "privacy notice" }),
  }),
  "/sign-in?link=expired": (page) => ({ text: page.getByText(SIGN_IN_TEXT.expired) }),
  "/sign-in?link=unavailable": (page) => ({ alert: page.getByText(SIGN_IN_TEXT.linkUnavailable) }),
  "/sign-in?account=deleted": (page) => ({ status: page.getByText(SIGN_IN_TEXT.deleted) }),
};

for (const colorScheme of ["light", "dark"] as const) {
  for (const [path, extra] of Object.entries(TEXT_PAGES)) {
    test(`the ${path} page text is readable in ${colorScheme} mode`, async ({ page }) => {
      await page.emulateMedia({ colorScheme });
      await page.goto(path);
      const targets: Record<string, Locator> = {
        heading: page.getByRole("heading", { level: 1 }),
        link: page.getByRole("link", { name: "Retrofit", exact: true }),
        ...extra(page),
      };
      for (const [name, el] of Object.entries(targets)) {
        await expect(el, name).toBeVisible();
        const { ratio, color, background } = await contrastOf(el);
        expect(ratio, `${name}: ${color} on ${background}`).toBeGreaterThanOrEqual(4.5);
      }
    });
  }
}

// The account page (with a failure notice), a saved report and the save button: the page tokens only, readable in both schemes.
for (const colorScheme of ["light", "dark"] as const) {
  test(`the account pages are readable in ${colorScheme} mode`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    const id = await analyzeFixture(page, "bakery.fixture.test");
    await signIn(page, newEmail(`theme-${colorScheme}`), `/r/${id}`);
    await page.getByRole("button", { name: SAVE_REPORT_TEXT.button }).click();
    const saved = page.getByTestId("save-report").getByRole("status");
    await expect(saved).toBeVisible();
    const check = async (targets: Record<string, Locator>) => {
      for (const [name, el] of Object.entries(targets)) {
        await expect(el, name).toBeVisible();
        const { ratio, color, background } = await contrastOf(el);
        expect(ratio, `${name}: ${color} on ${background}`).toBeGreaterThanOrEqual(4.5);
      }
    };
    await check({ saved, openAccount: page.getByRole("link", { name: SAVE_REPORT_TEXT.openAccount }) });
    await page.goto("/account?delete=failed");
    await check({
      heading: page.getByRole("heading", { level: 1 }),
      notice: page.getByText(ACCOUNT_TEXT.deleteFailed),
      email: page.getByTestId("account-email"),
      report: page.getByTestId("saved-reports").getByRole("link").first(),
      signOut: page.getByRole("button", { name: ACCOUNT_TEXT.signOut }),
      delete: page.getByRole("button", { name: ACCOUNT_TEXT.deleteButton }),
      confirm: page.getByText(ACCOUNT_TEXT.deleteConfirm),
    });
    await page.getByTestId("saved-reports").getByRole("link").first().click();
    await check({ heading: page.getByRole("heading", { level: 1 }), back: page.getByRole("link", { name: SAVED_REPORT_TEXT.back }), score: page.getByTestId("score-total") });
  });
}
