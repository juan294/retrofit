import { test, expect } from "./fixtures/csp";
import { PRIVACY, TERMS } from "@/lib/site/legal-texts";
import { PRICING_TEXT, UNSUBSCRIBE_TEXT } from "@/lib/site/pricing-texts";
import { ACCOUNT_TEXT, SAVE_REPORT_TEXT, SAVED_REPORT_TEXT } from "@/lib/site/account-texts";
import { SIGN_IN_TEXT } from "@/lib/site/sign-in-texts";
import { CONFIRM_PATH, markAsAsker, newEmail, signIn, signInFormState } from "./support/account";
import { analyzeFixture, mockOtari, submitKey } from "./support/agent";
import { BLOCKED_HOST, CLAIM_HOST, claimPanel, claimStates, FLAKY_HOST, FRESH_HOST, MISSING_HOST, mockLimit, setClockOffset } from "./support/claims";
import { CLAIMS_TEXT } from "@/lib/site/claims-texts";
import { PUBLISHED_PAGE_TEXT, PUBLISH_TEXT } from "@/lib/site/publish-texts";
import { billingStates, startBilling } from "./support/billing";
import { pageUrl, publishedOwner, publishStates, saveTestKey, setOutage, verifiedOwner } from "./support/publish";

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

/** Every target is visible with a WCAG contrast of at least 4.5 against its background. */
async function readable(targets: Record<string, Locator>): Promise<void> {
  for (const [name, el] of Object.entries(targets)) {
    await expect(el, name).toBeVisible();
    const { ratio, color, background } = await contrastOf(el);
    expect(ratio, `${name}: ${color} on ${background}`).toBeGreaterThanOrEqual(4.5);
  }
}

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
    await readable({ saved, openAccount: page.getByRole("link", { name: SAVE_REPORT_TEXT.openAccount }) });
    await page.goto("/account?delete=failed");
    await readable({
      heading: page.getByRole("heading", { level: 1 }),
      notice: page.getByText(ACCOUNT_TEXT.deleteFailed),
      email: page.getByTestId("account-email"),
      report: page.getByTestId("saved-reports").getByRole("link").first(),
      signOut: page.getByRole("button", { name: ACCOUNT_TEXT.signOut }),
      delete: page.getByRole("button", { name: ACCOUNT_TEXT.deleteButton }),
      confirm: page.getByText(ACCOUNT_TEXT.deleteConfirm),
    });
    await page.getByTestId("saved-reports").getByRole("link").first().click();
    await readable({ heading: page.getByRole("heading", { level: 1 }), back: page.getByRole("link", { name: SAVED_REPORT_TEXT.back }), score: page.getByTestId("score-total") });
  });
}

// The sign-in form's answers, the confirm page (with and without the other-browser warning) and the save error.
for (const colorScheme of ["light", "dark"] as const) {
  for (const state of ["sent", "limit", "error"] as const) {
    test(`the sign-in form's ${state} state is readable in ${colorScheme} mode`, async ({ page }) => {
      await page.emulateMedia({ colorScheme });
      await readable({ message: await signInFormState(page, state) });
    });
  }

  test(`the sign-in confirm page is readable in ${colorScheme} mode, with and without the warning`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    await page.goto(CONFIRM_PATH);
    await readable({ heading: page.getByRole("heading", { level: 1 }), intro: page.getByText(SIGN_IN_TEXT.confirmIntro), warning: page.getByTestId("other-browser"), button: page.getByRole("button", { name: SIGN_IN_TEXT.confirmButton }) });
    await markAsAsker(page);
    await page.goto(CONFIRM_PATH);
    await expect(page.getByTestId("other-browser")).toHaveCount(0);
    await readable({ button: page.getByRole("button", { name: SIGN_IN_TEXT.confirmButton }) });
  });

  test(`the save button's error is readable in ${colorScheme} mode`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    const id = await analyzeFixture(page, "bakery.fixture.test");
    await signIn(page, newEmail(`theme-error-${colorScheme}`), `/r/${id}`);
    await page.route("**/api/account/reports", (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "unavailable", message: SAVE_REPORT_TEXT.unavailable }) }));
    await page.getByRole("button", { name: SAVE_REPORT_TEXT.button }).click();
    await readable({ alert: page.getByTestId("save-report").getByRole("alert") });
  });
}

// Phase 3. Fails if any claim panel text (status, where to add it, reason, token, last check, buttons, a limit answer) is unreadable in either scheme.
for (const colorScheme of ["light", "dark"] as const) {
  test(`the claim panels are readable in ${colorScheme} mode`, async ({ page, browser }) => {
    test.setTimeout(180_000);
    await page.emulateMedia({ colorScheme });
    const { other, close } = await claimStates(page, browser, `theme-${colorScheme}`);
    const fresh = claimPanel(page, FRESH_HOST);
    const missing = claimPanel(page, MISSING_HOST);
    await readable({
      heading: page.getByRole("heading", { level: 2, name: CLAIMS_TEXT.heading }),
      lapsed: claimPanel(page, FLAKY_HOST).getByTestId("claim-status"),
      lapsedReason: claimPanel(page, FLAKY_HOST).getByTestId("claim-reason"),
      blockedReason: claimPanel(page, BLOCKED_HOST).getByTestId("claim-reason"),
      missingStatus: missing.getByTestId("claim-status"),
      missingWhere: missing.getByText(/^Retrofit looks for a retrofit-site-verification tag/),
      missingReason: missing.getByTestId("claim-reason"),
      superseded: claimPanel(page, CLAIM_HOST).getByTestId("claim-status"),
      host: claimPanel(page, CLAIM_HOST).getByText(/fixture\.test/).first(),
      token: fresh.getByTestId("claim-token").locator("code"),
      tokenNote: fresh.getByText(CLAIMS_TEXT.tokenOnce),
      created: fresh.getByTestId("claim-message"),
      lastChecked: claimPanel(page, BLOCKED_HOST).getByText(/^Last checked /),
      checkAgain: fresh.getByRole("button", { name: CLAIMS_TEXT.checkAgain }),
      startOver: fresh.getByRole("button", { name: CLAIMS_TEXT.startOver }),
      source: page.getByLabel(CLAIMS_TEXT.sourceLabel),
      claim: page.getByRole("button", { name: CLAIMS_TEXT.claimButton }),
    });
    await mockLimit(page, "/api/claims/check", CLAIMS_TEXT.limit);
    await fresh.getByRole("button", { name: CLAIMS_TEXT.checkAgain }).click();
    await readable({ limit: fresh.getByRole("alert") });
    await other.emulateMedia({ colorScheme });
    await other.goto("/account");
    await readable({ verified: other.getByTestId("claim-status"), verifiedReason: other.getByTestId("claim-reason") });
    await close();
  });
}

// Phase 4. Fails if any text of the publish controls, the public page, its key panel, its agent or its 404 page is unreadable in either scheme.
for (const colorScheme of ["light", "dark"] as const) {
  test(`the publish controls and the published page are readable in ${colorScheme} mode`, async ({ page, browser }) => {
    test.setTimeout(120_000);
    await page.emulateMedia({ colorScheme });
    const { visitor, pause, close } = await publishStates(page, browser, `theme-${colorScheme}`);
    const panel = claimPanel(page, FLAKY_HOST);
    await readable({
      link: panel.getByTestId("publish-link"),
      saved: panel.getByTestId("publish-saved"),
      error: panel.getByTestId("publish-error"),
      tryAgain: panel.getByRole("button", { name: PUBLISH_TEXT.tryAgain, exact: true }),
      unpublish: panel.getByRole("button", { name: PUBLISH_TEXT.unpublish }),
      badgeHeading: panel.getByText(PUBLISH_TEXT.badgeHeading),
      snippet: panel.getByTestId("badge-snippet"),
    });
    await visitor.emulateMedia({ colorScheme });
    await mockOtari(visitor);
    await readable({
      heading: visitor.getByRole("heading", { level: 1 }),
      publishedBy: visitor.getByTestId("published-by"),
      score: visitor.getByTestId("score-total"),
      agentHeading: visitor.getByTestId("published-agent").getByRole("heading", { level: 2 }).first(),
      ownKey: visitor.getByText(PUBLISHED_PAGE_TEXT.ownKey),
      keyLabel: visitor.getByText("Paste your key", { exact: true }),
      connect: visitor.getByRole("button", { name: "Connect", exact: true }),
      check: visitor.getByTestId("check-aw.manifest").locator("strong"),
    });
    await submitKey(visitor);
    const mount = visitor.getByTestId("preview-mount");
    await readable({ title: mount.locator(".ns-title").first(), actions: mount.getByText(/website actions? connected/).first() });
    await pause();
    await readable({ paused: panel.getByTestId("publish-paused") });
    await visitor.goto(visitor.url());
    await readable({ heading: visitor.getByRole("heading", { level: 1, name: PUBLISHED_PAGE_TEXT.notFoundTitle }), text: visitor.getByText(PUBLISHED_PAGE_TEXT.notFound), analyze: visitor.getByRole("link", { name: PUBLISHED_PAGE_TEXT.analyze }) });
    await close();
    await panel.getByRole("button", { name: PUBLISH_TEXT.unpublish }).click();
    await readable({ unpublished: panel.getByText(PUBLISH_TEXT.unpublished) });
  });

  test(`the Publish offer and a limit answer are readable in ${colorScheme} mode`, async ({ page }) => {
    test.setTimeout(60_000);
    await page.emulateMedia({ colorScheme });
    await verifiedOwner(page, FLAKY_HOST, `theme-offer-${colorScheme}`);
    const panel = claimPanel(page, FLAKY_HOST);
    await readable({ intro: panel.getByText(PUBLISH_TEXT.intro), publish: panel.getByRole("button", { name: PUBLISH_TEXT.publish, exact: true }) });
    await mockLimit(page, "/api/publish", PUBLISH_TEXT.limit);
    await panel.getByRole("button", { name: PUBLISH_TEXT.publish, exact: true }).click();
    await readable({ limit: panel.getByRole("alert") });
  });
}

// Phase 4 review. Fails if the saved key offer or the outage page of a published site is unreadable in either scheme.
for (const colorScheme of ["light", "dark"] as const) {
  test(`the saved key offer and the outage page of a published site are readable in ${colorScheme} mode`, async ({ page }) => {
    test.setTimeout(60_000);
    await page.emulateMedia({ colorScheme });
    await publishedOwner(page, CLAIM_HOST, `theme-outage-${colorScheme}`);
    await saveTestKey(page);
    await page.goto(pageUrl(CLAIM_HOST));
    await readable({ use: page.getByRole("button", { name: "Use your saved key" }), note: page.getByTestId("saved-key").locator("p") });
    try {
      await setOutage(page, true);
      await page.goto(pageUrl(CLAIM_HOST));
      await readable({
        heading: page.getByRole("heading", { level: 1, name: PUBLISHED_PAGE_TEXT.unavailableTitle }),
        text: page.getByText(PUBLISHED_PAGE_TEXT.unavailable),
        retry: page.getByRole("button", { name: PUBLISHED_PAGE_TEXT.tryAgain }),
      });
    } finally {
      await setOutage(page, false);
    }
  });
}

// Phase 5. Fails if a billing state's text (the list is billingStates') is unreadable in either scheme.
for (const colorScheme of ["light", "dark"] as const) {
  test(`the billing states are readable in ${colorScheme} mode`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.emulateMedia({ colorScheme });
    try {
      await startBilling(page.request);
      await billingStates(page, `theme-${colorScheme}`, readable);
    } finally {
      await setClockOffset(page.request, 0);
    }
  });
}
