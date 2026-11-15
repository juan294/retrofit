import { test, expect } from "./fixtures/csp";
import { fixtureOrigin } from "./support/global-setup";
import { CALLER_DENIED_ORIGIN } from "@/lib/test-fixtures/origins";
import { hostsOf, openCaller } from "./support/caller";
import { OTARI, traceEvents } from "./support/agent";

const PEER_A = "peer-a.fixture.test:3011";
const PEER_A_FACT = "The Peer A demo harbor ferry leaves at 09:30 every day.";

test.describe("spec §6 locally (organizers' cases L1 to L10, C1 to C8)", () => {
  test("a two-agent network runs in the browser", async ({ page }) => {
    const s = await openCaller(page);
    await s.send("hello");
    await expect(s.chat().getByText("Hello from Retrofit's agent.").filter({ visible: true }).first()).toBeVisible({ timeout: 20_000 });
    const front = s.router.bodies[0]!;
    // The front agent can hand off to the second agent of the network.
    expect(front.tools?.map((t) => t.function.name)).toContain("readiness_specialist");
  });

  test("score_site runs as the grounded site capability", async ({ page }) => {
    const s = await openCaller(page);
    await s.send(`score ${fixtureOrigin("bakery.fixture.test")}`);
    await expect(s.chat().getByText(/Score result:/).filter({ visible: true }).first()).toBeVisible({ timeout: 60_000 });
    const tools = (await traceEvents(page)).filter((e) => e.kind === "tool" && e.phase === "end" && e.tool === "website_score_site");
    expect(tools.length).toBeGreaterThan(0);
    expect(String(tools[0]!.resultPreview)).toMatch(/"ok":true|"status":"(ready|running)"/);
  });

  test("consent names the peer before any contact; decline sends nothing; approve runs the peer locally", async ({ page }) => {
    const s = await openCaller(page);
    await s.send("call peer_demo");
    const card = s.chat().locator(".ns-consent").last();
    await expect(card).toContainText(PEER_A);
    expect(hostsOf(s.requests)).not.toContain(PEER_A);
    await card.getByRole("button", { name: "Decline" }).click();
    await expect(s.chat().getByText(/Results:/).filter({ visible: true }).first()).toBeVisible({ timeout: 20_000 });
    expect(hostsOf(s.requests)).not.toContain(PEER_A);

    await s.send("call peer_demo");
    const card2 = s.chat().locator(".ns-consent").last();
    await card2.getByRole("button", { name: "Allow", exact: true }).click();
    await expect(s.chat().getByText(new RegExp(PEER_A_FACT.replace(/[.]/g, "\\."))).filter({ visible: true }).first()).toBeVisible({ timeout: 20_000 });
    const peerRequests = s.requests.filter((r) => new URL(r.url()).host === PEER_A);
    expect(peerRequests.length).toBeGreaterThan(0);
    // No request to the peer carries the key or a cookie.
    for (const r of peerRequests) {
      const h = await r.allHeaders();
      expect(JSON.stringify(h)).not.toContain(OTARI.key);
      expect(h["authorization"]).toBeUndefined();
      expect(h["cookie"]).toBeUndefined();
    }
    // The router stays the caller's: every model call goes to the caller's router, none to the peer's.
    expect(hostsOf(s.requests)).not.toContain("third.fixture.test:3013");
    expect(s.router.bodies.some((b) => /for another site's assistant/.test(b.messages[0]?.content ?? ""))).toBe(true);
    // Private context is filtered: with no allow rule, the peer invocation carries no backend_token.
    const call = (await traceEvents(page)).find((e) => e.kind === "remote_call" && e.phase === "start");
    expect(call).toBeTruthy();
    expect(JSON.stringify((call!.requestPayload as Record<string, unknown>)?.sly_data ?? {})).not.toContain("backend_token");
  });

  test("an invalid peer network shows a visible error", async ({ page }) => {
    const s = await openCaller(page);
    await s.send("call invalid_peer_demo");
    await s.chat().locator(".ns-consent").last().getByRole("button", { name: "Allow", exact: true }).click();
    await expect(page.getByTestId("preview-notices").locator('[data-kind="error"]')).toContainText("missing_specialist", { timeout: 20_000 });
  });

  test("a turn over the runtime's per-partner budget shows a visible limit notice", async ({ page }) => {
    const s = await openCaller(page);
    await s.send("call peer_demo peer_demo");
    await s.chat().locator(".ns-consent").last().getByRole("button", { name: "Always allow" }).click();
    await expect(page.getByTestId("preview-notices").locator('[data-kind="limit"]')).toBeVisible({ timeout: 20_000 });
  });

  test("a peer outside allowed_peers shows a visible refusal and is never contacted", async ({ page }) => {
    const s = await openCaller(page, CALLER_DENIED_ORIGIN);
    await s.send("call peer_demo");
    await s.chat().locator(".ns-consent").last().getByRole("button", { name: "Allow", exact: true }).click();
    await expect(page.getByTestId("preview-notices").locator('[data-kind="denied"]')).toContainText(PEER_A, { timeout: 20_000 });
    expect(hostsOf(s.requests)).not.toContain(PEER_A);
  });

  test("a cycle is prevented: no back edge in the peer hop, no second caller fetch, a skip event and a loop notice", async ({ page }) => {
    const s = await openCaller(page);
    const callerNetworkFetches = () => s.requests.filter((r) => r.url().endsWith("/retrofit_guide_e2e.network.json")).length;
    const before = callerNetworkFetches();
    await s.send("call loop_peer_demo");
    await s.chat().locator(".ns-consent").last().getByRole("button", { name: "Allow", exact: true }).click();
    await expect(s.chat().getByText(/Results:/).filter({ visible: true }).first()).toBeVisible({ timeout: 20_000 });
    const hop = s.router.bodies.filter((b) => /for another site's assistant/.test(b.messages[0]?.content ?? ""));
    expect(hop.length).toBeGreaterThan(0);
    for (const b of hop) expect((b.tools ?? []).map((t) => t.function.name)).not.toContain("retrofit_guide_e2e");
    expect(callerNetworkFetches()).toBe(before);
    const skip = (await traceEvents(page)).find((e) => e.kind === "composition_skip");
    expect(skip?.reason).toBe("already visited in this request");
    await expect(page.getByTestId("preview-notices").locator('[data-kind="loop"]')).toContainText("Retrofit skipped a call back to http://caller-e2e.fixture.test:3010/retrofit_guide_e2e to prevent a loop.");
  });
});
