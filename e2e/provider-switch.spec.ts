import { test, expect } from "./fixtures/csp";
import { OTARI, analyzeFixture, connectKey, mockOtari, previewScript } from "./support/agent";
import { installMockRouter, sse, type MockRouter } from "./support/mock-router";
import { UPSTREAM_MODEL } from "./support/mock-upstream";
import { RETROFIT_ORIGIN, recordRequests, type Page, type RecordedRequest } from "./support/extra-requests";

type PwRequest = import("@playwright/test").Request;

const GROQ = { routerBase: "https://api.groq.com/openai/v1", model: "openai/gpt-oss-120b", key: "gsk_test_e2e_0123456789abcdef" };
const BLOCKED = /Retrofit blocked a request to https:\/\/api\.groq\.com that was not approved\./;

async function routers(page: Page): Promise<{ a: MockRouter; b: MockRouter }> {
  const a = await mockOtari(page);
  const b = await installMockRouter(page, { routerBase: GROQ.routerBase, model: GROQ.model, script: previewScript });
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

/**
 * "Connected to ..." can show before the preview reboots: wait until the booted runtime holds
 * `key`, so a request typed next goes to the new runtime and not to the one being replaced.
 */
async function runtimeHolds(page: Page, key: string) {
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __nsweb?: { engine?: { byokKey?: string } } }).__nsweb?.engine?.byokKey ?? null), { timeout: 20_000 })
    .toBe(key);
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
  await runtimeHolds(page, OTARI.key);
  await ask(page, a);
  expect(b.authorizations).toEqual([]);

  const beforeSwitch = (await log.all()).length;
  const aCount = a.authorizations.length;
  await page.getByLabel("Paste a different key").fill(GROQ.key);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByText(/Connected to Groq/)).toBeVisible();
  await runtimeHolds(page, GROQ.key);
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
  await runtimeHolds(page, OTARI.key);
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

test("Forget my key returns to the free path and no provider gets another request", async ({ page, context }) => {
  const log = recordRequests(context);
  const { a, b } = await routers(page);
  await analyzeFixture(page, "bakery.fixture.test");
  await expect(page.getByText(/Using Retrofit's free AI/)).toBeVisible();
  await connectKey(page);
  await runtimeHolds(page, OTARI.key);
  await ask(page, a);

  const beforeForget = (await log.all()).length;
  const aCount = a.authorizations.length;
  await page.getByRole("button", { name: "Forget my key" }).click();
  // Phase 6: the free path comes back (the runtime reboots with Retrofit's own router).
  await expect(page.getByLabel("Paste your key")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Use your own key" })).toBeVisible();
  await expect(page.getByText(/Connected to/)).toHaveCount(0);
  await expect(page.getByText(/Using Retrofit's free AI/)).toBeVisible();
  await expect(page.getByTestId("preview-mount").locator('[data-ns-slot="chat"]')).toBeVisible();
  await page.waitForTimeout(1_000);

  const after = (await log.all()).slice(beforeForget);
  expect(onOrigin(after, OTARI.routerBase).map((r) => r.url)).toEqual([]);
  expect(onOrigin(after, GROQ.routerBase).map((r) => r.url)).toEqual([]);
  expect(a.authorizations.length).toBe(aCount);
  expect(b.authorizations).toEqual([]);

  // A runtime that outlives its preview still meets the guard: the forgotten provider is closed.
  const blocked = await page.evaluate(async (url) => {
    try {
      await fetch(url, { method: "POST", body: "{}" });
      return "sent";
    } catch (e) {
      return String((e as Error).message);
    }
  }, `${OTARI.routerBase}/chat/completions`);
  expect(blocked).toBe("Retrofit blocked a request to https://api.otari.ai that was not approved.");
  // The free runtime that replaced it holds the placeholder key, never the forgotten one.
  expect(await page.evaluate(() => JSON.stringify((window as unknown as { __nsweb?: { engine?: { byokKey?: string } } }).__nsweb?.engine?.byokKey ?? null))).not.toContain(OTARI.key);
});

test("connecting a key while a delayed free answer with a tool call is in flight stops the free runtime", async ({ page, context }) => {
  const log = recordRequests(context);
  const a = await mockOtari(page);
  const FREE_CHAT = `${RETROFIT_ORIGIN}/api/inference/v1/chat/completions`;
  let freeChats = 0;
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  const failed: string[] = [];
  page.on("requestfailed", (r) => {
    if (r.url() === FREE_CHAT) failed.push(r.failure()?.errorText ?? "");
  });
  // The free model answers its first call late, with a delegation the runtime would execute
  // (a tool round-trip that asks the free model again). Later calls answer at once.
  await page.route(FREE_CHAT, async (route) => {
    freeChats += 1;
    if (freeChats === 1) await released;
    const turn = freeChats === 1 ? { call: [{ name: "content_specialist", args: { request: "opening hours" } }] } : { text: "Free answer after the switch." };
    await route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: sse(turn, UPSTREAM_MODEL) }).catch(() => undefined);
  });
  await analyzeFixture(page, "bakery.fixture.test");
  await expect(page.getByText(/Using Retrofit's free AI/)).toBeVisible();
  const input = page.getByTestId("preview-mount").getByRole("textbox").last();
  await expect(input).toBeEnabled();
  await input.fill("What are your opening hours?");
  await input.press("Enter");
  await expect.poll(() => freeChats, { timeout: 20_000 }).toBe(1);

  const beforeSwitch = (await log.all()).length;
  await connectKey(page);
  await runtimeHolds(page, OTARI.key);
  // The held free answer arrives only after the switch.
  release();
  await page.waitForTimeout(1_500);
  // The retired runtime's pending call was aborted, and it asked the free path nothing more.
  expect(freeChats).toBe(1);
  expect(failed).toHaveLength(1);
  await ask(page, a);
  await page.waitForTimeout(500);
  const after = (await log.all()).slice(beforeSwitch);
  expect(after.filter((r) => r.url === FREE_CHAT).map((r) => r.method)).toEqual([]);
  expect(freeChats).toBe(1);
  await expect(page.getByTestId("preview-mount").getByText("Free answer after the switch.")).toHaveCount(0);
});

test("connecting a key while the free runtime loads its network aborts that load and leaves only the new runtime", async ({ page }) => {
  const a = await mockOtari(page);
  // Hold the free runtime's network load: an agent artifact, which the guard ties to the active runtime.
  let networkLoads = 0;
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let held: PwRequest | null = null;
  const failed: PwRequest[] = [];
  page.on("requestfailed", (r) => failed.push(r));
  await page.route(
    (url) => url.pathname.startsWith("/p/") && url.pathname.endsWith(".network.json"),
    async (route) => {
      networkLoads += 1;
      if (networkLoads === 1) {
        held = route.request();
        await released;
      }
      await route.continue().catch(() => undefined);
    },
  );
  await analyzeFixture(page, "bakery.fixture.test");
  await expect(page.getByText(/Using Retrofit's free AI/)).toBeVisible();
  await expect.poll(() => networkLoads, { timeout: 20_000 }).toBe(1);
  await connectKey(page);
  await expect.poll(() => networkLoads, { timeout: 20_000 }).toBe(2);
  await runtimeHolds(page, OTARI.key);
  // Retiring the free runtime aborted its held load, so its boot never completes.
  await expect.poll(() => held !== null && failed.includes(held)).toBe(true);
  release();
  await page.waitForTimeout(1_000);
  expect(await page.evaluate(() => (window as unknown as { __nsweb?: { engine?: { byokKey?: string } } }).__nsweb?.engine?.byokKey ?? null)).toBe(OTARI.key);
  await expect(page.getByTestId("preview-mount").locator('[data-ns-slot="chat"]')).toHaveCount(1);
  await ask(page, a);
});

test("a replaced runtime whose boot finishes late does not take over the live runtime's handle", async ({ page }) => {
  const { a, b } = await routers(page);
  await analyzeFixture(page, "bakery.fixture.test");
  await expect(page.getByText(/Using Retrofit's free AI/)).toBeVisible();
  await expect(page.getByTestId("preview-mount").locator('[data-ns-slot="chat"]')).toBeVisible();
  // Hold provider A's router probe (engine.js:160-162). The guard passes this request without tying
  // it to the runtime, so A's boot finishes after the switch to B (registered last, so it answers first).
  let probes = 0;
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  await page.route(`${new URL(OTARI.routerBase).origin}/agent-manifest.json`, async (route) => {
    probes += 1;
    if (probes === 1) await released;
    await route.fallback();
  });
  await connectKey(page);
  await expect.poll(() => probes, { timeout: 20_000 }).toBe(1);
  await page.getByLabel("Paste a different key").fill(GROQ.key);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByText(/Connected to Groq/)).toBeVisible();
  await runtimeHolds(page, GROQ.key);
  // A's boot completes now and writes its handle over B's; Preview must put B's back.
  release();
  await expect.poll(() => a.probes.length, { timeout: 20_000 }).toBe(1);
  await page.waitForTimeout(1_000);
  expect(await page.evaluate(() => (window as unknown as { __nsweb?: { engine?: { byokKey?: string } } }).__nsweb?.engine?.byokKey ?? null)).toBe(GROQ.key);
  await expect(page.getByTestId("preview-mount").locator('[data-ns-slot="chat"]')).toHaveCount(1);
  await ask(page, b);
  expect(a.bodies).toEqual([]);
});
