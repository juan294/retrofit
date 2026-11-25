// Judge access at /judges (UX-H3) and the judge form before hydration (FE-M1).
import { test, expect } from "./fixtures/csp";

const CODE = "judge-code-e2e";
const DAY_MS = 86_400_000;

test.afterEach(async ({ request }) => {
  await request.post("/test-fixtures/clock", { data: { offsetMs: 0 } });
});

// Fails if Enter before hydration can submit the form as GET, or at all.
test("before hydration the judge code cannot enter the URL", async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  const urls: string[] = [];
  page.on("request", (r) => void urls.push(r.url()));
  await page.goto("/judges");
  await expect(page.getByRole("button", { name: "Turn on judge access" })).toBeDisabled();
  await page.getByLabel("Judge code").fill(CODE);
  await page.getByLabel("Judge code").press("Enter");
  await expect(page).toHaveURL(/\/judges$/);
  expect(urls.filter((u) => u.includes(CODE))).toEqual([]);
  await context.close();
});

// Fails if the code needs a public session first, the page leaves a judge without a next step, the panel does not say
// that judge access is on, or access ends during a break of days.
test("one code entry keeps judge access on, and the panel says so", async ({ page, request }) => {
  const asked: string[] = [];
  page.on("request", (r) => void (r.url().includes("/api/inference/") && asked.push(new URL(r.url()).pathname)));
  await page.goto("/judges");
  await page.getByLabel("Judge code").fill(CODE);
  await page.getByRole("button", { name: "Turn on judge access" }).click();
  await expect(page.locator("#judge-code-status")).toHaveText("Judge access is on for this browser.");
  expect(asked).toEqual(["/api/inference/session/judge"]);

  await page.getByRole("link", { name: "Go to the home page" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByText("Judge access is on. Using Retrofit's free AI")).toBeVisible();

  // Five days later, without a visit in between (server clock, fixtures mode).
  await request.post("/test-fixtures/clock", { data: { offsetMs: 5 * DAY_MS } });
  await page.reload();
  await expect(page.getByText("Judge access is on. Using Retrofit's free AI")).toBeVisible();
});
