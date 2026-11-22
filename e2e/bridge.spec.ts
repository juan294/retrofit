import { test, expect } from "./fixtures/csp";
import { RETROFIT_ORIGIN } from "./support/extra-requests";
import { fixtureOrigin } from "./support/global-setup";

const HOST_PAGE = "http://peer-a.fixture.test:3011/bridge-host.html";
const BRIDGE = `${RETROFIT_ORIGIN}/bridge/action-bridge.html`;

test("a page on another origin frames Retrofit's action bridge and completes the handshake", async ({ page }) => {
  const bridgeResponse = page.waitForResponse((r) => r.url() === BRIDGE);
  const scriptResponse = page.waitForResponse((r) => r.url() === `${RETROFIT_ORIGIN}/runtime/action-bridge.js`);
  await page.goto(HOST_PAGE);

  const result = page.locator("#result");
  await expect(result).toHaveAttribute("data-state", "connected", { timeout: 15_000 });
  const outcome = JSON.parse((await result.textContent()) ?? "{}") as { state: string; readyOrigin?: string; catalog?: unknown };
  expect(outcome.state).toBe("connected");
  expect(outcome.readyOrigin).toBe(RETROFIT_ORIGIN);
  // The bridge shares exactly score_site, as a read, with a caller on any origin.
  const catalog = outcome.catalog as { name: string; effect: string; availability: string }[];
  expect(catalog.map((a) => [a.name, a.effect, a.availability])).toEqual([["score_site", "read", "bridge"]]);

  const response = await bridgeResponse;
  expect(response.status()).toBe(200);
  const headers = await response.allHeaders();
  expect(headers["content-security-policy"]).toBe("script-src 'self'; frame-ancestors *");
  expect(headers["x-frame-options"]).toBeUndefined();
  expect(headers["content-type"]).toMatch(/^text\/html/);

  // The bridge script itself loaded from Retrofit's origin as JavaScript (check_partner.mjs needs it).
  const script = await scriptResponse;
  expect(script.status()).toBe(200);
  expect((await script.allHeaders())["content-type"]).toMatch(/javascript/);

  // The bridge really is the framed document from Retrofit's origin.
  const frame = page.frames().find((f) => f.url() === BRIDGE);
  expect(frame, "bridge frame").toBeDefined();
});

test("a partner page runs score_site through Retrofit's bridge and gets the same score as /api/score", async ({ page, request }) => {
  test.setTimeout(120_000);
  const site = fixtureOrigin("bakery.fixture.test");
  // Score the site first, so the bridge call reads the cached ready answer instead of "running".
  let expected: { status?: string; score?: number } = {};
  await expect
    .poll(
      async () => {
        const res = await request.get(`/api/score?url=${encodeURIComponent(site)}`);
        expected = (await res.json()) as typeof expected;
        return res.status();
      },
      { timeout: 60_000, intervals: [1_000] },
    )
    .toBe(200);
  expect(expected.status).toBe("ready");

  await page.goto(`${HOST_PAGE}?score=${encodeURIComponent(site)}`);
  const result = page.locator("#result");
  await expect(result).toHaveAttribute("data-state", "connected", { timeout: 30_000 });
  const outcome = JSON.parse((await result.textContent()) ?? "{}") as { executed?: { ok: boolean; error?: string; value?: { ok: boolean; status: string; report?: { score: number | null } } } };
  expect(outcome.executed?.error).toBeUndefined();
  expect(outcome.executed?.value).toMatchObject({ ok: true, status: "ready" });
  expect(outcome.executed?.value?.report?.score).toBe(expected.score);
});
