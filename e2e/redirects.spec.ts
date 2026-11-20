import { test, expect } from "./fixtures/csp";
import { hostsOf, openCaller } from "./support/caller";

const THIRD = "third.fixture.test:3013";
const PEER_B = "peer-b.fixture.test:3011";
const BLOCKED = (origin: string) => `Retrofit blocked a request to ${origin} that was not approved.`;
const REDIRECT = (origin: string) => `Retrofit blocked a redirect from ${origin} to an address that was not approved.`;

/** Each variant is reached after approving peer-a only; the guard must stop the destination it points at. */
const cases: { tool: string; text: string; host: string; path?: string }[] = [
  { tool: "redirect_manifest_peer_demo", text: REDIRECT("http://peer-a.fixture.test:3011"), host: THIRD },
  { tool: "hocon_third_peer_demo", text: BLOCKED("http://third.fixture.test:3013"), host: THIRD },
  { tool: "network_redirect_peer_demo", text: REDIRECT("http://peer-a.fixture.test:3011"), host: THIRD },
  { tool: "hocon_peer_b_peer_demo", text: BLOCKED("http://peer-b.fixture.test:3011"), host: PEER_B },
  { tool: "hocon_router_peer_demo", text: BLOCKED("https://api.otari.ai"), host: "api.otari.ai", path: "/hocon-router/" },
];

for (const c of cases) {
  test(`${c.tool}: no request reaches ${c.host}${c.path ?? ""} and chat shows the blocked text`, async ({ page }) => {
    const s = await openCaller(page);
    await s.send(`call ${c.tool}`);
    await s.chat().locator(".ns-consent").last().getByRole("button", { name: "Allow", exact: true }).click();
    await expect(page.getByTestId("preview-notices")).toContainText(c.text, { timeout: 20_000 });
    const reached = s.requests.filter((r) => new URL(r.url()).host === c.host && (!c.path || new URL(r.url()).pathname.startsWith(c.path)));
    // A redirect hop shows up as the 302 response from peer-a; the browser never requests the target.
    expect(reached.map((r) => r.url())).toEqual([]);
    if (c.host !== "api.otari.ai") expect(hostsOf(s.requests)).not.toContain(c.host);
  });
}

test("a configured peer becomes reachable only through its own consent card", async ({ page }) => {
  const s = await openCaller(page);
  await s.send("call hocon_peer_b_peer_demo");
  await s.chat().locator(".ns-consent").last().getByRole("button", { name: "Allow", exact: true }).click();
  await expect(page.getByTestId("preview-notices")).toContainText(BLOCKED("http://peer-b.fixture.test:3011"), { timeout: 20_000 });
  expect(hostsOf(s.requests)).not.toContain(PEER_B);

  await s.send("call peer_b_demo");
  const card = s.chat().locator(".ns-consent").last();
  await expect(card).toContainText(PEER_B);
  await card.getByRole("button", { name: "Allow", exact: true }).click();
  await expect(s.chat().getByText(/The Peer B demo museum opens at 10:00 on weekdays\./).filter({ visible: true }).first()).toBeVisible({ timeout: 20_000 });
  expect(hostsOf(s.requests)).toContain(PEER_B);
});
