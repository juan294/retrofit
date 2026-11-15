import { test, expect } from "./fixtures/csp";

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
