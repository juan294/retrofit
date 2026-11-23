import { test, expect } from "./fixtures/csp";

test.describe("pricing and notify me", () => {
  // Fails if a plan or the free-period note is missing, the consent box starts ticked, or the privacy link is absent.
  test("the pricing page shows the plans, the free-period note, an unticked consent box and the privacy link", async ({ page }) => {
    await page.goto("/pricing");
    await expect(page.getByRole("heading", { level: 1, name: "Pricing" })).toBeVisible();
    for (const name of ["Free", "Pro", "Agency"]) await expect(page.getByRole("heading", { level: 2, name, exact: true })).toBeVisible();
    await expect(page.getByText("Free during the hackathon judging period")).toBeVisible();
    await expect(page.getByRole("checkbox", { name: "Send me product news" })).not.toBeChecked();
    await expect(page.getByRole("link", { name: "privacy notice" })).toHaveAttribute("href", "/privacy");
  });

  // Fails if the button stays disabled after hydration (it is disabled in the server HTML so an early click cannot submit).
  test("the notify button is enabled once the page is hydrated", async ({ page }) => {
    await page.goto("/pricing");
    await expect(page.getByRole("button", { name: "Notify me" })).toBeEnabled();
  });

  // Fails if the form does not post the address with consent false for an unticked box, or the confirmation does not show.
  test("notify me posts the address with consent false and shows the confirmation", async ({ page }) => {
    await page.goto("/pricing");
    await page.getByLabel("Email").fill("e2e-unticked@example.test");
    const posted = page.waitForRequest((r) => r.url().endsWith("/api/notify") && r.method() === "POST");
    await page.getByRole("button", { name: "Notify me" }).click();
    expect((await posted).postDataJSON()).toEqual({ email: "e2e-unticked@example.test", consent: false });
    await expect(page.getByRole("status")).toHaveText("You're on the list. We will email you when paid plans start.");
  });

  // Fails if a ticked box is not sent as consent, or a repeat signup answers differently from a new one.
  test("a ticked box sends consent true, and a repeat signup gets the same confirmation", async ({ page }) => {
    await page.goto("/pricing");
    for (const consent of [true, false]) {
      await page.getByLabel("Email").fill("E2E-Ticked@Example.test");
      if (consent) await page.getByRole("checkbox", { name: "Send me product news" }).check();
      const posted = page.waitForRequest((r) => r.url().endsWith("/api/notify") && r.method() === "POST");
      await page.getByRole("button", { name: "Notify me" }).click();
      expect((await posted).postDataJSON()).toEqual({ email: "E2E-Ticked@Example.test", consent });
      await expect(page.getByRole("status")).toHaveText("You're on the list. We will email you when paid plans start.");
    }
  });

  // Fails if an empty address is posted instead of being refused in the page.
  test("an empty address shows the field error and posts nothing", async ({ page }) => {
    await page.goto("/pricing");
    let posts = 0;
    page.on("request", (r) => void (r.url().endsWith("/api/notify") && posts++));
    await page.getByRole("button", { name: "Notify me" }).click();
    await expect(page.locator("main").getByRole("alert")).toHaveText("Enter your email address.");
    expect(posts).toBe(0);
  });
});

test.describe("privacy, terms and unsubscribe", () => {
  // Fails if the home page footer stops linking to the three pages, or one of them does not serve its heading.
  test("the home page footer links to pricing, privacy and terms, and each page serves", async ({ page }) => {
    await page.goto("/");
    const footer = page.locator("footer");
    for (const [name, heading] of [
      ["Pricing", "Pricing"],
      ["Privacy", "Privacy"],
      ["Terms", "Terms"],
    ] as const) {
      await footer.getByRole("link", { name, exact: true }).click();
      await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
      await page.goBack();
    }
  });

  // Fails if opening a link unsubscribes (mail scanners open links), the confirm button does not post, or an
  // unknown link answers like a valid one, or the page is indexable.
  test("an unsubscribe link shows a confirm button; confirming an unknown link shows the invalid-link text", async ({ page }) => {
    await page.goto("/unsubscribe?t=0123456789abcdef0123456789abcdef");
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
    await expect(page.getByText("Unsubscribe this address from Retrofit's email?")).toBeVisible();
    const posted = page.waitForRequest((r) => r.url().endsWith("/api/unsubscribe") && r.method() === "POST");
    await page.getByRole("button", { name: "Unsubscribe" }).click();
    expect((await posted).postData()).toBe("t=0123456789abcdef0123456789abcdef");
    await expect(page).toHaveURL(/\/unsubscribe\?result=invalid$/);
    await expect(page.locator("main").getByRole("alert")).toHaveText("This unsubscribe link is not valid. Email retrofit@thecreativetoken.com and we will remove your address.");
  });

  // Fails if a malformed link gets a confirm form instead of the invalid-link text.
  test("a malformed unsubscribe link shows the invalid-link text and no button", async ({ page }) => {
    await page.goto("/unsubscribe?t=not-a-token");
    await expect(page.locator("main").getByRole("alert")).toHaveText("This unsubscribe link is not valid. Email retrofit@thecreativetoken.com and we will remove your address.");
    await expect(page.getByRole("button", { name: "Unsubscribe" })).toHaveCount(0);
  });
});
