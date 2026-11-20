import { test, expect } from "./fixtures/csp";
import { RETROFIT_ORIGIN } from "./support/extra-requests";

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
  expect(outcome.catalog).toBeDefined();

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
