import { test, expect } from "./fixtures/csp";
import { OTARI, analyzeFixture, connectKey, previewScript } from "./support/agent";
import { installMockRouter, type MockRouter } from "./support/mock-router";
import { RETROFIT_ORIGIN, recordRequests, stubRouterProbe, type Page, type RecordedRequest } from "./support/extra-requests";

const GROQ = { routerBase: "https://api.groq.com/openai/v1", model: "openai/gpt-oss-120b", key: "gsk_test_e2e_0123456789abcdef" };
const BLOCKED = /Retrofit blocked a request to https:\/\/api\.groq\.com that was not approved\./;

async function routers(page: Page): Promise<{ a: MockRouter; b: MockRouter }> {
  const a = await installMockRouter(page, { routerBase: OTARI.routerBase, model: OTARI.model, script: previewScript });
  const b = await installMockRouter(page, { routerBase: GROQ.routerBase, model: GROQ.model, script: previewScript });
  await stubRouterProbe(page, OTARI.routerBase);
  await stubRouterProbe(page, GROQ.routerBase);
  return { a, b };
}

async function ask(page: Page, router: MockRouter) {
  const before = router.bodies.length;
  const mount = page.getByTestId("preview-mount");
  const input = mount.getByRole("textbox").last();
  await expect(input).toBeEnabled();
  await input.fill("What are your opening hours?");
  await input.press("Enter");
  await expect.poll(() => router.bodies.length, { timeout: 20_000 }).toBeGreaterThanOrEqual(before + 4);
  await expect(mount.getByText(/Our opening hours are Monday to Friday/).filter({ visible: true }).last()).toBeVisible({ timeout: 20_000 });
  await expect(input).toBeEnabled({ timeout: 20_000 });
}

const onOrigin = (rs: RecordedRequest[], base: string) => rs.filter((r) => r.origin === new URL(base).origin && r.method !== "OPTIONS");

/** Tries a request from the page, through whatever fetch the page has installed. */
const tryFetch = (page: Page, url: string, init: { method?: string; body?: string } = {}) =>
  page.evaluate(
    async ({ url, init }) => {
      try {
        const r = await fetch(url, init);
        return `status ${r.status}`;
      } catch (e) {
        return `error ${e instanceof Error ? e.message : String(e)}`;
      }
    },
    { url, init },
  );

test("switching from provider A to provider B validates at B, then chats only with B", async ({ page, context }) => {
  const log = recordRequests(context);
  const { a, b } = await routers(page);
  await analyzeFixture(page, "bakery.fixture.test");
  await connectKey(page);
  await ask(page, a);
  expect(b.authorizations).toEqual([]);

  const beforeSwitch = (await log.all()).length;
  const aCount = a.authorizations.length;
  await page.getByLabel("Paste a different key").fill(GROQ.key);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByText(/Connected to Groq/)).toBeVisible();
  await ask(page, b);

  const after = (await log.all()).slice(beforeSwitch);
  const bRequests = onOrigin(after, GROQ.routerBase);
  // Validation reached B's /models before any chat request to B.
  const firstModels = bRequests.findIndex((r) => r.method === "GET" && r.url === `${GROQ.routerBase}/models` && r.headers["authorization"] === `Bearer ${GROQ.key}`);
  const firstChat = bRequests.findIndex((r) => r.method === "POST" && r.url === `${GROQ.routerBase}/chat/completions`);
  expect(firstModels).toBeGreaterThanOrEqual(0);
  expect(firstChat).toBeGreaterThan(firstModels);
  expect(b.bodies.length).toBeGreaterThanOrEqual(4);
  expect(bRequests.filter((r) => r.method === "POST").every((r) => r.headers["authorization"] === `Bearer ${GROQ.key}`)).toBe(true);
  // Provider A received nothing after the switch, and the old key went nowhere.
  expect(onOrigin(after, OTARI.routerBase).map((r) => `${r.method} ${r.url}`)).toEqual([]);
  expect(a.authorizations.length).toBe(aCount);
  expect(after.filter((r) => Object.values(r.headers).some((v) => v.includes(OTARI.key))).map((r) => r.url)).toEqual([]);
  // A lost access: the guard refuses a chat request to A from this page.
  expect(await tryFetch(page, `${OTARI.routerBase}/chat/completions`, { method: "POST", body: "{}" })).toMatch(/^error Retrofit blocked a request to https:\/\/api\.otari\.ai that was not approved\.$/);
  expect(a.authorizations.length).toBe(aCount);
  // No free path before Phase 6.
  expect(after.filter((r) => r.origin === RETROFIT_ORIGIN && r.url.includes("/api/inference"))).toEqual([]);
});

test("a failed validation of provider B leaves provider A active and B without access", async ({ page, context }) => {
  const log = recordRequests(context);
  const { a, b } = await routers(page);
  // Registered after B's mock router, so this answers B's /models first: the key is refused.
  let bModels = 0;
  await page.route(`${GROQ.routerBase}/models`, (route) => {
    if (route.request().method() === "OPTIONS") return route.fallback();
    bModels++;
    return route.fulfill({ status: 401, headers: { "access-control-allow-origin": "*", "content-type": "application/json" }, body: JSON.stringify({ error: { message: "Invalid API Key" } }) });
  });
  await analyzeFixture(page, "bakery.fixture.test");
  await connectKey(page);
  await ask(page, a);

  const beforeSwitch = (await log.all()).length;
  await page.getByLabel("Paste a different key").fill(GROQ.key);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Groq did not accept this key." })).toBeVisible();
  expect(bModels).toBe(1);
  // A stays connected and keeps answering.
  await expect(page.getByText(/Connected to Otari/)).toBeVisible();
  await expect(page.getByText(/Connected to Groq/)).toHaveCount(0);
  await ask(page, a);

  const after = (await log.all()).slice(beforeSwitch);
  const bRequests = onOrigin(after, GROQ.routerBase);
  expect(bRequests.map((r) => `${r.method} ${new URL(r.url).pathname}`)).toEqual(["GET /openai/v1/models"]);
  expect(b.bodies).toEqual([]);
  expect(onOrigin(after, OTARI.routerBase).filter((r) => r.method === "POST").length).toBeGreaterThanOrEqual(4);
  // B has no access at all now: even its /models is refused before any network contact.
  expect(await tryFetch(page, `${GROQ.routerBase}/models`)).toMatch(new RegExp(`^error ${BLOCKED.source}$`));
  expect(await tryFetch(page, `${GROQ.routerBase}/chat/completions`, { method: "POST", body: "{}" })).toMatch(new RegExp(`^error ${BLOCKED.source}$`));
  expect(bModels).toBe(1);
  expect(b.bodies).toEqual([]);
});

test("Forget my key returns to the key prompt and no provider gets another request", async ({ page, context }) => {
  const log = recordRequests(context);
  const { a, b } = await routers(page);
  await analyzeFixture(page, "bakery.fixture.test");
  await expect(page.getByText(/Using Retrofit's free AI/)).toHaveCount(0);
  await connectKey(page);
  await ask(page, a);

  const beforeForget = (await log.all()).length;
  const aCount = a.authorizations.length;
  await page.getByRole("button", { name: "Forget my key" }).click();
  // Before Phase 6 there is no free path: the key prompt comes back and the runtime is gone.
  await expect(page.getByLabel("Paste your key")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Connect your AI key" })).toBeVisible();
  await expect(page.getByText(/Connected to/)).toHaveCount(0);
  await expect(page.getByTestId("preview-mount")).toHaveCount(0);
  await expect(page.getByText(/Using Retrofit's free AI/)).toHaveCount(0);
  await page.waitForTimeout(1_000);

  const after = (await log.all()).slice(beforeForget);
  expect(onOrigin(after, OTARI.routerBase).map((r) => r.url)).toEqual([]);
  expect(onOrigin(after, GROQ.routerBase).map((r) => r.url)).toEqual([]);
  expect(after.filter((r) => r.url.includes("/api/inference")).map((r) => r.url)).toEqual([]);
  expect(a.authorizations.length).toBe(aCount);
  expect(b.authorizations).toEqual([]);
});
