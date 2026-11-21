import { test, expect } from "./fixtures/csp";
import { OTARI, analyzeFixture, connectKey, mockOtari } from "./support/agent";
import { RETROFIT_ORIGIN, recordRequests } from "./support/extra-requests";

test("a preview session contacts only Retrofit's origin and the selected router origin", async ({ page, context }) => {
  const log = recordRequests(context);
  const router = await mockOtari(page);
  await analyzeFixture(page, "bakery.fixture.test");
  await connectKey(page);
  const mount = page.getByTestId("preview-mount");
  const input = mount.getByRole("textbox").last();
  await input.fill("What are your opening hours?");
  await input.press("Enter");
  await expect(mount.getByText(/Our opening hours are Monday to Friday/).filter({ visible: true }).first()).toBeVisible({ timeout: 20_000 });
  expect(router.bodies.length).toBeGreaterThanOrEqual(2);
  // Let trailing requests (status polls, late assets) start before the log is read.
  await page.waitForTimeout(500);

  const requests = await log.all();
  const routerOrigin = new URL(OTARI.routerBase).origin;
  const others = requests.filter((r) => r.origin !== RETROFIT_ORIGIN && r.origin !== routerOrigin).map((r) => `${r.method} ${r.url}`);
  expect(others, "requests to any other origin").toEqual([]);
  // Both allowed origins were really used.
  expect(requests.some((r) => r.origin === RETROFIT_ORIGIN && /\/p\/[0-9a-f]{32}\/agent-manifest\.json$/.test(r.url))).toBe(true);
  expect(requests.filter((r) => r.origin === routerOrigin && r.method === "POST").every((r) => r.url === `${OTARI.routerBase}/chat/completions`)).toBe(true);
  // On the router origin only the router's own paths are used (no probe of other paths).
  const routerPaths = new Set(requests.filter((r) => r.origin === routerOrigin && r.method !== "OPTIONS").map((r) => `${r.method} ${new URL(r.url).pathname}`));
  // The runtime probes the router origin once per boot (runtime/engine.js:41-52); answered in the browser.
  expect(router.probes.length).toBeLessThanOrEqual(1);
  for (const p of routerPaths) expect(["GET /api/v1/models", "POST /api/v1/chat/completions", "GET /agent-manifest.json"]).toContain(p);
});
