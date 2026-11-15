import { test, expect } from "./fixtures/csp";
import { connectKey, mockOtari, traceEvents } from "./support/agent";
import { callerScript, hostsOf } from "./support/caller";
import { DENIED_ORIGIN } from "@/lib/peer/conformance";
import { PEER_FIXTURE_HOST, PEER_HOST as PEER } from "@/lib/peer/host";

type Page = import("@playwright/test").Page;
type Request = import("@playwright/test").Request;

const DENIED_HOST = new URL(DENIED_ORIGIN).host;

/** Serves the production peer origin from this deployment's own peer route (fixtures host), inside the test browser. */
async function mapPeer(page: Page) {
  await page.route(`https://${PEER}/**`, async (route) => {
    const url = new URL(route.request().url());
    const res = await route.fetch({ url: `http://127.0.0.1:3010${url.pathname}${url.search}`, headers: { ...route.request().headers(), host: PEER_FIXTURE_HOST } });
    await route.fulfill({ response: res });
  });
}

async function openConformance(page: Page) {
  const requests: Request[] = [];
  page.on("request", (r) => requests.push(r));
  await mapPeer(page);
  const router = await mockOtari(page, callerScript);
  await page.goto("/conformance");
  await connectKey(page);
  const mount = page.getByTestId("preview-mount");
  await expect(mount.locator('[data-ns-slot="chat"]')).toBeVisible();
  const send = async (text: string) => {
    const input = mount.getByRole("textbox").last();
    await input.fill(text);
    await input.press("Enter");
  };
  return { requests, router, mount, send };
}

test.describe("spec §6 with the production-shaped caller (retrofit_conformance and demo-harbor, mapped to loopback)", () => {
  test("consent names demo-harbor, and approving runs harbor_tours in the browser", async ({ page }) => {
    const s = await openConformance(page);
    await s.send("call harbor_tours");
    const card = s.mount.locator(".ns-consent").last();
    await expect(card).toContainText(PEER);
    expect(hostsOf(s.requests)).not.toContain(PEER);
    await card.getByRole("button", { name: "Allow", exact: true }).click();
    await expect(s.mount.getByText(/Harbor fact: the morning harbor tour leaves at 10:00\./).filter({ visible: true }).first()).toBeVisible({ timeout: 20_000 });
    expect(hostsOf(s.requests)).toContain(PEER);
    for (const r of s.requests.filter((x) => new URL(x.url()).host === PEER)) {
      const h = await r.allHeaders();
      expect(h["authorization"]).toBeUndefined();
      expect(h["cookie"]).toBeUndefined();
    }
    const call = (await traceEvents(page)).find((e) => e.kind === "remote_call" && e.phase === "start");
    expect(JSON.stringify((call?.requestPayload as Record<string, unknown>)?.sly_data ?? {})).not.toContain("backend_token");
  });

  test("harbor_invalid shows the invalid-network error", async ({ page }) => {
    const s = await openConformance(page);
    await s.send("call harbor_invalid");
    await s.mount.locator(".ns-consent").last().getByRole("button", { name: "Allow", exact: true }).click();
    await expect(page.getByTestId("preview-notices").locator('[data-kind="error"]')).toBeVisible({ timeout: 20_000 });
  });

  test("the demo-denied tool shows the refusal and no request reaches that host", async ({ page }) => {
    const s = await openConformance(page);
    await s.send("call none");
    await s.mount.locator(".ns-consent").last().getByRole("button", { name: "Allow", exact: true }).click();
    await expect(page.getByTestId("preview-notices").locator('[data-kind="denied"]')).toContainText(DENIED_HOST, { timeout: 20_000 });
    expect(hostsOf(s.requests)).not.toContain(DENIED_HOST);
  });
});
