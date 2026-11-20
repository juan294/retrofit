import { KEY_ITEM } from "@/lib/keys/storage";
import { test, expect } from "./fixtures/csp";
import { OTARI, analyzeFixture, connectKey, mockOtari, openKeyForm } from "./support/agent";
import { RETROFIT_ORIGIN, recordRequests, type Page, recordStorageWrites, storageNames, whereSecretAppears } from "./support/extra-requests";

const RUNTIME_PREFIX = "nsweb-byok-";
const RUNTIME_COOKIE = "nsweb_byok_profiles_v1";

/** Sends one question in the preview and waits for the scripted answer. */
async function askHours(page: Page) {
  const mount = page.getByTestId("preview-mount");
  const input = mount.getByRole("textbox").last();
  await input.fill("What are your opening hours?");
  await input.press("Enter");
  await expect(mount.getByText(/Our opening hours are Monday to Friday/).filter({ visible: true }).first()).toBeVisible({ timeout: 20_000 });
}

test("the key goes only to the provider, never to Retrofit's origin", async ({ page, context }) => {
  const log = recordRequests(context);
  const router = await mockOtari(page);
  const id = await analyzeFixture(page, "bakery.fixture.test");
  await connectKey(page);
  await askHours(page);
  // A reload restores the tab's key and boots again: the restore path must not send it either.
  await page.reload();
  await expect(page.getByText(/Connected to Otari/)).toBeVisible();
  await expect(page.getByTestId("preview-mount").locator('[data-ns-slot="chat"]')).toBeVisible();

  const requests = await log.all();
  const own = requests.filter((r) => r.origin === RETROFIT_ORIGIN);
  expect(own.length).toBeGreaterThan(5);
  expect(own.some((r) => r.url.includes(`/p/${id}/`))).toBe(true);
  const leaks = own.map((r) => ({ url: r.url, where: whereSecretAppears(r, OTARI.key) })).filter((l) => l.where.length);
  expect(leaks, "requests to Retrofit's origin that carry the key").toEqual([]);
  // No request anywhere puts the key in a URL.
  expect(requests.filter((r) => whereSecretAppears(r, OTARI.key).includes("url")).map((r) => r.url)).toEqual([]);
  // The browser holds no cookie with the key for any origin.
  const cookies = await context.cookies();
  expect(cookies.filter((c) => c.value.includes(OTARI.key) || decodeURIComponent(c.value).includes(OTARI.key)).map((c) => c.name)).toEqual([]);

  // The scripted router received it, as a Bearer token on /models and on every chat request.
  expect(router.modelRequests).toBeGreaterThanOrEqual(1);
  expect(router.bodies.length).toBeGreaterThanOrEqual(4);
  expect(router.authorizations.length).toBeGreaterThan(0);
  const routerRequests = requests.filter((r) => r.url.startsWith(`${OTARI.routerBase}/`) && r.method !== "OPTIONS");
  expect(routerRequests.length).toBeGreaterThan(0);
  // Every chat request and the key panel's validation carry the key as Bearer. The runtime's own
  // model check (runtime/ui.js:1085-1091) reads the hidden settings field, which holds no key,
  // so it sends GET /models without Authorization; no request carries any other value.
  const auth = (r: (typeof routerRequests)[number]) => r.headers["authorization"] ?? null;
  const chats = routerRequests.filter((r) => r.method === "POST");
  expect(chats.length).toBe(router.bodies.length);
  expect(chats.filter((r) => auth(r) !== `Bearer ${OTARI.key}`).map((r) => r.url), "chat requests without the Bearer key").toEqual([]);
  expect(routerRequests.some((r) => r.method === "GET" && r.url === `${OTARI.routerBase}/models` && auth(r) === `Bearer ${OTARI.key}`), "key validation").toBe(true);
  expect(routerRequests.filter((r) => auth(r) !== null && auth(r) !== `Bearer ${OTARI.key}`).map((r) => `${r.method} ${r.url}`)).toEqual([]);
  for (const r of routerRequests.filter((x) => auth(x) === null)) expect(`${r.method} ${r.url}`).toBe(`GET ${OTARI.routerBase}/models`);
  for (const r of routerRequests.filter((x) => auth(x) !== null)) expect(whereSecretAppears(r, OTARI.key), r.url).toEqual(["header authorization"]);
});

test("the runtime writes no nsweb-byok item during a chat, and Forget my key clears every key item", async ({ page }) => {
  const writes = await recordStorageWrites(page);
  await mockOtari(page);
  await analyzeFixture(page, "bakery.fixture.test");
  await connectKey(page);
  await askHours(page);

  const written = await writes();
  const runtimeWrites = [...written.local, ...written.session].filter((n) => n.startsWith(RUNTIME_PREFIX));
  expect(runtimeWrites, "nsweb-byok-* items written during the chat").toEqual([]);
  expect(written.cookies.filter((n) => n === RUNTIME_COOKIE), "runtime cookie writes during the chat").toEqual([]);
  const during = await storageNames(page);
  expect([...during.local, ...during.session].filter((n) => n.startsWith(RUNTIME_PREFIX))).toEqual([]);
  expect(during.cookies).not.toContain(RUNTIME_COOKIE);
  // Remember is unticked by default: the key sits in this tab's sessionStorage only.
  expect(during.session).toContain(KEY_ITEM);
  expect(during.local).not.toContain(KEY_ITEM);

  // Seed what the runtime's own settings panel would store (runtime/byok.js), so Forget has
  // something of each kind to clear: a profile, the tab setup items and the loopback cookie.
  await page.evaluate(
    ({ key, router, model }) => {
      const store = { version: 1, selectedId: "p1", updatedAt: new Date().toISOString(), profiles: [{ id: "p1", label: "e2e", key, router, model }] };
      localStorage.setItem("nsweb-byok-profiles-v1", JSON.stringify(store));
      localStorage.setItem("retrofit-key-v1-extra", "x");
      for (const [n, v] of [["nsweb-byok-tab-key", key], ["nsweb-byok-key", key], ["nsweb-byok-router", router], ["nsweb-byok-model", model]]) sessionStorage.setItem(n!, v!);
      document.cookie = `nsweb_byok_profiles_v1=${encodeURIComponent(JSON.stringify(store))}; Path=/; Max-Age=600; SameSite=Lax`;
    },
    { key: OTARI.key, router: OTARI.routerBase, model: OTARI.model },
  );
  const seeded = await storageNames(page);
  expect(seeded.cookies).toContain(RUNTIME_COOKIE);

  await page.getByRole("button", { name: "Forget my key" }).click();
  // Back to the free path (Phase 6), with the key prompt offered again in the closed "own key" disclosure.
  await expect(page.getByTestId("own-key").locator(":scope > summary")).toHaveText("Use your own AI key (optional)");
  await expect(page.getByText(/Connected to Otari/)).toHaveCount(0);
  await expect(page.getByText(/Using Retrofit's free AI/)).toBeVisible();

  const after = await storageNames(page);
  expect(after.local.filter((n) => n.startsWith(KEY_ITEM) || n.startsWith(RUNTIME_PREFIX)), "localStorage key items after Forget").toEqual([]);
  expect(after.session.filter((n) => n.startsWith(KEY_ITEM) || n.startsWith(RUNTIME_PREFIX)), "sessionStorage key items after Forget").toEqual([]);
  expect(after.cookies, "runtime cookie after Forget").not.toContain(RUNTIME_COOKIE);
  const cookies = await page.context().cookies();
  expect(cookies.map((c) => c.name)).not.toContain(RUNTIME_COOKIE);
});

test("with Remember on this device unticked, a new tab does not get the key", async ({ page, context }) => {
  await mockOtari(page);
  const id = await analyzeFixture(page, "bakery.fixture.test");
  await openKeyForm(page);
  await expect(page.getByRole("checkbox", { name: "Remember on this device" })).not.toBeChecked();
  await connectKey(page);
  await expect(page.getByTestId("preview-mount").locator('[data-ns-slot="chat"]')).toBeVisible();

  const second = await context.newPage();
  const router2 = await mockOtari(second);
  await second.goto(`/r/${id}`);
  await expect(second.getByTestId("score-total")).toBeVisible({ timeout: 30_000 });
  await expect(second.getByTestId("own-key").locator(":scope > summary")).toBeVisible();
  await expect(second.getByText(/Connected to Otari/)).toHaveCount(0);
  // Without a remembered key the new tab runs on the free path.
  await expect(second.getByText(/Using Retrofit's free AI/)).toBeVisible();
  const names = await storageNames(second);
  expect([...names.local, ...names.session].filter((n) => n.startsWith(KEY_ITEM))).toEqual([]);
  expect(router2.authorizations).toEqual([]);
  await second.close();
});

test("with Remember on this device ticked, a new tab restores the key", async ({ page, context }) => {
  await mockOtari(page);
  const id = await analyzeFixture(page, "bakery.fixture.test");
  await openKeyForm(page);
  await page.getByRole("checkbox", { name: "Remember on this device" }).check();
  await connectKey(page);
  const first = await storageNames(page);
  expect(first.local).toContain(KEY_ITEM);
  expect(first.session).not.toContain(KEY_ITEM);

  const second = await context.newPage();
  const router2 = await mockOtari(second);
  await second.goto(`/r/${id}`);
  await expect(second.getByText(/Connected to Otari/)).toBeVisible({ timeout: 30_000 });
  await expect(second.getByLabel("Paste a different key")).toBeVisible();
  await expect(second.getByRole("checkbox", { name: "Remember on this device" })).toBeChecked();
  await askHours(second);
  // The restored key reaches the router: every chat request carries it as Bearer.
  expect(router2.bodies.length).toBeGreaterThanOrEqual(4);
  expect(router2.authorizations).toContain(`Bearer ${OTARI.key}`);
  expect(router2.authorizations.filter((a) => a !== "" && a !== `Bearer ${OTARI.key}`)).toEqual([]);
  await second.close();
});

test("with a visitor key, no request goes to /api/inference after the key connects", async ({ page, context }) => {
  const seen: string[] = [];
  context.on("request", (r) => seen.push(r.url()));
  const router = await mockOtari(page);
  await analyzeFixture(page, "bakery.fixture.test");
  await connectKey(page);
  const from = seen.length;
  await askHours(page);
  expect(seen.slice(from).filter((u) => u.includes("/api/inference"))).toEqual([]);
  expect(router.bodies.length).toBeGreaterThan(0);
});

test("a remembered key starts no free session", async ({ page, context }) => {
  await mockOtari(page);
  await analyzeFixture(page, "bakery.fixture.test");
  await openKeyForm(page);
  await page.getByRole("checkbox", { name: "Remember on this device" }).check();
  await connectKey(page);
  const second = await context.newPage();
  await mockOtari(second);
  const sessions: string[] = [];
  second.on("request", (r) => r.url().endsWith("/api/inference/session") && sessions.push(r.url()));
  await second.goto("/");
  await expect(second.getByText(/Connected to Otari/)).toBeVisible();
  await second.waitForTimeout(500);
  expect(sessions).toEqual([]);
  await second.close();
});
