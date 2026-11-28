import { test, expect } from "./fixtures/csp";
import { PRICING_TEXT } from "@/lib/site/pricing-texts";

function nonceOf(csp: string | undefined): string {
  const m = /'nonce-([^']+)'/.exec(csp ?? "");
  if (!m?.[1]) throw new Error(`no nonce in ${csp}`);
  return m[1];
}

test("landing page renders with a per-response nonce and first-party requests only", async ({ page, request, baseURL }) => {
  const origin = new URL(baseURL!).origin;
  const foreign: string[] = [];
  page.on("request", (r) => {
    if (new URL(r.url()).origin !== origin && !r.url().startsWith("data:")) foreign.push(r.url());
  });

  const response = await page.goto("/");
  expect(response?.headers()["x-content-type-options"]).toBe("nosniff");
  expect(response?.headers()["cache-control"]).toContain("no-store");
  await expect(page.getByRole("heading", { level: 1, name: "Retrofit" })).toBeVisible();
  await expect(page.getByText("An agent on your own website that can take the order, and it is yours to keep.")).toBeVisible();

  const a = await request.get("/");
  const b = await request.get("/");
  expect(nonceOf(a.headers()["content-security-policy"])).not.toBe(nonceOf(b.headers()["content-security-policy"]));

  // Hydration finished and a client navigation (reload through the router) causes no violation.
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => window.history.pushState({}, "", "/?again=1"));
  await page.reload();
  await page.waitForLoadState("networkidle");
  expect(foreign).toEqual([]);
});

// UX-H1. Fails if a page has no link to the plans or the account, a page load asks for the account page (a prefetch) or sets an account
// cookie, or a signed-out visitor who follows the link does not reach sign-in.
test("every public page links to the plans and the account, without asking for the account", async ({ page, context }) => {
  const asked: string[] = [];
  page.on("request", (r) => void asked.push(new URL(r.url()).pathname));
  for (const path of ["/", "/conformance", "/bot", "/pricing", "/privacy", "/sign-in", `/r/${"0".repeat(32)}`, "/s/unknown.example.com"]) {
    await page.goto(path);
    const nav = page.getByRole("navigation", { name: "Retrofit" });
    await expect(nav.getByRole("link", { name: "Pricing" }), path).toHaveAttribute("href", "/pricing");
    await expect(nav.getByRole("link", { name: "Account" }), path).toHaveAttribute("href", "/account");
    await nav.getByRole("link", { name: "Account" }).hover();
    // Give a prefetch the time it would need.
    await page.waitForTimeout(300);
  }
  expect(asked.filter((p) => p.startsWith("/account"))).toEqual([]);
  expect((await context.cookies()).map((c) => c.name)).not.toContain("retrofit_account");
  await page.goto("/pricing");
  await page.getByRole("link", { name: PRICING_TEXT.accountLink }).click();
  await expect(page).toHaveURL(/\/sign-in\?returnTo=%2Faccount$/);
});

// FE-M1. Without JavaScript the page stays as it is before hydration.
test.describe("before hydration", () => {
  test.use({ javaScriptEnabled: false });

  // Fails if an early click or Enter submits the address form (as a GET it would reload the page with the address in its URL).
  test("the address form's button is disabled and Enter submits nothing", async ({ page, baseURL }) => {
    const requests: string[] = [];
    await page.goto("/");
    page.on("request", (r) => void requests.push(`${r.method()} ${r.url()}`));
    await expect(page.getByRole("button", { name: "Score my site" })).toBeDisabled();
    const field = page.getByLabel("Your website address");
    await field.fill("https://early.example.com");
    await field.press("Enter");
    await page.waitForTimeout(500);
    expect(page.url()).toBe(`${baseURL}/`);
    expect(requests.filter((r) => r.includes("early") || r.startsWith("POST"))).toEqual([]);
  });
});
