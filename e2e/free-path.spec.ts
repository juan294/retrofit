import { test, expect } from "./fixtures/csp";
import { analyzeFixture, traceEvents } from "./support/agent";
import { PARTIAL_TRIGGER, resetUpstreamLog, upstreamLog } from "./support/mock-upstream";

type Page = import("@playwright/test").Page;

async function ask(page: Page, text: string) {
  const input = page.getByTestId("preview-mount").getByRole("textbox").last();
  await input.fill(text);
  await input.press("Enter");
}

/** Opens Retrofit's own agent and waits for the free-path banner. */
async function openFree(page: Page) {
  await page.goto("/");
  await expect(page.getByText("Using Retrofit's free AI")).toBeVisible();
}

/** The first visible match for `text` in the preview chat. */
const chatText = (page: Page, text: string | RegExp) => page.getByTestId("preview-mount").getByText(text).filter({ visible: true }).first();

async function status(page: Page): Promise<{ available: boolean; pool: string; sid?: string; calls?: number; publicSpentTodayMicro?: number }> {
  return page.evaluate(async () => (await fetch("/api/inference/status", { credentials: "same-origin" })).json());
}

test.beforeEach(async () => {
  await resetUpstreamLog();
});

test.afterEach(async ({ request }) => {
  await request.post("/test-fixtures/clock", { data: { offsetMs: 0 } });
});

test("a visitor without a key previews bakery on the free path, through a delegation and a tool result", async ({ page }) => {
  await analyzeFixture(page, "bakery.fixture.test");
  await expect(page.getByText("Using Retrofit's free AI")).toBeVisible();
  // The key panel stays out of the way while the free AI works: closed, and no "Forget my key" without a key.
  await expect(page.getByTestId("own-key")).not.toHaveAttribute("open");
  await expect(page.getByLabel("Paste your key")).toBeHidden();
  await expect(page.getByRole("button", { name: "Forget my key" })).toHaveCount(0);
  await ask(page, "What are your opening hours?");
  await expect(chatText(page, /Our opening hours are Monday to Friday 7:00 to 18:00/)).toBeVisible({ timeout: 20_000 });
  const chats = (await upstreamLog()).filter((e) => e.path === "chat");
  // The model call after the website_search_site_content result went through the proxy (no 400).
  expect(chats.some((e) => e.body?.messages.some((m) => m.role === "tool" && m.name === "website_search_site_content"))).toBe(true);
  // The upstream sees the server key, never a visitor cookie, and the proxy's forced fields.
  for (const e of chats) {
    expect(e.authorization).toBe("Bearer otk_server_e2e_only");
    expect(e.cookie).toBe("");
    expect(e.body).toMatchObject({ n: 1, stream: true, stream_options: { include_usage: true }, max_tokens: 1024 });
  }
  const models = (await traceEvents(page)).filter((ev) => ev.kind === "model_call" && ev.phase === "end");
  expect(models.length).toBeGreaterThan(0);
  expect(models.every((ev) => ev.status !== "error")).toBe(true);
});

test("while the free AI starts, the key form stays closed and the page says the free AI is starting", async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await page.route("**/api/inference/session", async (route) => {
    await held;
    await route.continue();
  });
  await page.goto("/");
  await expect(page.getByText("Starting Retrofit's free AI")).toBeVisible();
  await expect(page.getByTestId("own-key")).not.toHaveAttribute("open");
  await expect(page.getByLabel("Paste your key")).toBeHidden();
  release();
  await expect(page.getByText("Using Retrofit's free AI")).toBeVisible();
  await expect(page.getByText("Starting Retrofit's free AI")).toHaveCount(0);
  await expect(page.getByTestId("own-key")).not.toHaveAttribute("open");
});

test("Retrofit's own agent uses its published default router on the free path", async ({ page }) => {
  await openFree(page);
  await ask(page, "hello");
  await expect(chatText(page, "Hello from Retrofit's agent.")).toBeVisible({ timeout: 20_000 });
  const requests = (await traceEvents(page)).filter((ev) => ev.kind === "model_call" && ev.phase === "start");
  expect(requests.length).toBeGreaterThan(0);
  expect((await upstreamLog()).filter((e) => e.path === "chat").length).toBeGreaterThan(0);
});

test("renewal keeps the session and its count; two tabs share it; UTC midnight resets only the daily pool", async ({ page, context, request }) => {
  // Start one minute before the next UTC midnight (server clock, fixtures mode), so renewal can cross it.
  const now = Date.now();
  const d = new Date(now);
  const nextMidnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  const offset = nextMidnight - now - 60_000;
  await request.post("/test-fixtures/clock", { data: { offsetMs: offset } });

  await openFree(page);
  await ask(page, "hello");
  await expect(chatText(page, "Hello from Retrofit's agent.")).toBeVisible({ timeout: 20_000 });
  const before = await status(page);
  expect(before.calls).toBe(1);
  expect(before.publicSpentTodayMicro).toBeGreaterThan(0);

  const tab2 = await context.newPage();
  await openFree(tab2);
  const shared = await status(tab2);
  expect(shared.sid).toBe(before.sid);

  // Cross UTC midnight by two minutes, then renew: same session, same count, the new day's pool is open.
  await request.post("/test-fixtures/clock", { data: { offsetMs: offset + 120_000 } });
  await page.evaluate(async () => fetch("/api/inference/session", { method: "POST", credentials: "same-origin" }));
  const after = await status(page);
  expect(after.sid).toBe(before.sid);
  expect(after.calls).toBe(1);
  expect(after.available).toBe(true);
  // The daily public pool reset at UTC midnight; the session's own count did not.
  expect(after.publicSpentTodayMicro).toBe(0);
});

test("at the session cap the chat shows the cap text and the banner offers a key", async ({ page }) => {
  await openFree(page);
  // FREE_CALLS_PER_SESSION is 12 for the e2e server.
  for (let i = 0; i < 13; i++) {
    await ask(page, "hello");
    await page.waitForTimeout(150);
  }
  await expect(page.getByTestId("free-banner")).toContainText("Retrofit's free AI is used up for", { timeout: 20_000 });
  // The chat shows the cap text too (the runtime's error bubble carries the proxy's message).
  await expect(chatText(page, /Retrofit's free AI is used up for/)).toBeVisible();
  // The bubble shows the message, not the runtime's "LLM HTTP 429: {json}".
  await expect(page.getByTestId("preview-mount").locator(".ns-msg.bot").filter({ hasText: /LLM HTTP|"error"/ })).toHaveCount(0);
  await expect(page.getByTestId("free-banner").getByRole("link", { name: "Use your own key" })).toBeVisible();
});

test("a partial upstream answer then a failure shows the provider text and no partial answer, with no retry", async ({ page }) => {
  await openFree(page);
  await ask(page, `hello ${PARTIAL_TRIGGER}`);
  await expect(chatText(page, /The free AI provider did not answer/)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("PARTIAL ANSWER THAT MUST NOT SHOW")).toHaveCount(0);
  await page.waitForTimeout(1000);
  expect((await upstreamLog()).filter((e) => e.path === "chat").length).toBe(1);
});
