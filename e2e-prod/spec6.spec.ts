// Spec §6 against the production deployment (phase-7.md, "Production evidence (step 12)").
// The production pages, peer (demo-harbor) and fetch guard run unchanged. The BYOK router is
// scripted inside the test browser with a test key; there is no server switch. One case,
// tagged @real-model, uses Retrofit's free path with one real model call.
// Each test names its case; the evidence fixture writes the report after every check ran.
import { test, expect } from "./fixtures/csp";
import { OTARI, traceEvents } from "../e2e/support/agent";
import { SPECIALIST_ANSWER, SPECIALIST_SYSTEM, delegationScript, hostsOf } from "../e2e/support/caller";
import { toolNames, type ChatBody } from "../e2e/support/mock-router";
import { DENIED_ORIGIN } from "@/lib/peer/conformance";
import { PEER_HOST, RETROFIT_ORIGIN } from "@/lib/peer/host";
import { askAndWaitForAnswer, freeChatRequests, isLoopHop, openWithTestKey, scoreScript } from "./support/prod";
import { prodUrl } from "./support/report";

type Request = import("@playwright/test").Request;

const PROD = new URL(prodUrl());
const DENIED_HOST = new URL(DENIED_ORIGIN).host;
const OTARI_HOST = new URL(OTARI.routerBase).host;
/** The private sly_data field the runtime's chat sends on every turn (public/runtime/ui.js:571); no allow rule lets it reach a peer. */
const CALLER_PRIVATE_SLY_KEY = "backend_token";
const HARBOR_FACT = /Harbor fact: the morning harbor tour leaves at 10:00\./;
const LOOP_NOTICE = `Retrofit skipped a call back to ${RETROFIT_ORIGIN}/retrofit_conformance to prevent a loop.`;
/** A fetch of Retrofit's conformance network (the back edge harbor_loop would follow). */
const isConformanceFetch = (r: Request) => {
  const u = new URL(r.url());
  return u.host === new URL(RETROFIT_ORIGIN).host && /^\/retrofit_conformance(\.network\.json)?$/.test(u.pathname);
};
const peerRequests = (requests: Request[]) => requests.filter((r) => new URL(r.url()).host === PEER_HOST);
const isPeerHopBody = (b: ChatBody) => /Harbor tours demo/.test(b.messages.find((m) => m.role === "system")?.content ?? "");

test.describe("spec §6 in production (/conformance and the landing assistant)", () => {
  // Real-provider smoke: a real model on the free path. It cannot make the model delegate, so the
  // second agent's execution is proven by the scripted spec6-two-agent-delegation case below.
  test("real-model smoke: the landing assistant answers on the published default router (free path, one real model call)", { tag: "@real-model" }, async ({ page, evidence }) => {
    evidence.case("free-path-real-model-smoke");
    const requests: Request[] = [];
    page.on("request", (r) => requests.push(r));
    await page.goto("/");
    await expect(page.getByText("Using Retrofit's free AI")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("preview-mount").locator('[data-ns-slot="chat"]')).toBeVisible({ timeout: 30_000 });
    const answer = await askAndWaitForAnswer(page, "In one sentence, what does Retrofit do?");
    const chats = freeChatRequests(requests);
    expect(chats.length).toBeGreaterThan(0);
    const manifest = (await (await page.request.get("/agent-manifest.json")).json()) as { llm_router?: { base_url?: string } };
    // The published default router is the one the browser called.
    expect(chats[0]!.url()).toBe(`${manifest.llm_router?.base_url}/chat/completions`);
    const front = JSON.parse(chats[0]!.postData() ?? "{}") as ChatBody;
    // The second agent is offered; whether a real model delegates is not asserted here.
    expect(toolNames(front)).toContain("readiness_specialist");
    const responses = await Promise.all(chats.map(async (r) => (await r.response())?.status() ?? 0));
    expect(responses.every((s) => s === 200)).toBe(true);
    const ends = (await traceEvents(page)).filter((e) => e.kind === "model_call" && e.phase === "end");
    expect(ends.length).toBeGreaterThan(0);
    expect(ends.every((e) => e.status !== "error")).toBe(true);
    evidence.record({ realModelCalls: chats.length, router: manifest.llm_router?.base_url, answerChars: answer.length });
  });

  // Scripted conformance (V13): the front agent of the landing network delegates, readiness_specialist
  // runs in the browser with its own instructions and its answer returns as the tool result.
  test("the two-agent network delegates to readiness_specialist and returns its result (scripted model)", async ({ page, evidence }) => {
    evidence.case("spec6-two-agent-delegation");
    const request = `How ready is ${PROD.origin}/ for AI agents?`;
    const s = await openWithTestKey(page, "/", delegationScript(request));
    await s.send("How ready is Retrofit's own site?");
    await expect(s.mount.getByText(/Front answer: Specialist result:/).filter({ visible: true }).first()).toBeVisible({ timeout: 30_000 });
    const [front, ...rest] = s.router.bodies;
    expect(toolNames(front!)).toContain("readiness_specialist");
    const specialist = rest.filter((b) => SPECIALIST_SYSTEM.test(b.messages.find((m) => m.role === "system")?.content ?? ""));
    expect(specialist).toHaveLength(1);
    expect(specialist[0]!.messages.find((m) => m.role === "user")?.content).toBe(request);
    const toolMessage = rest.flatMap((b) => b.messages).find((m) => m.role === "tool");
    expect(toolMessage?.name).toBe("readiness_specialist");
    expect(toolMessage?.content).toContain(SPECIALIST_ANSWER);
    const events = await traceEvents(page);
    const agents = events.filter((e) => e.kind === "agent" && e.agent === "readiness_specialist");
    expect(agents.map((e) => e.phase)).toEqual(["start", "end"]);
    expect(agents[1]!.status).not.toBe("error");
    const results = events.filter((e) => e.kind === "tool_result" && e.tool === "readiness_specialist");
    expect(results).toHaveLength(1);
    evidence.record({
      scriptedModel: true,
      specialistModelRequests: specialist.length,
      delegatedRequest: request,
      toolResultName: toolMessage?.name ?? null,
      specialistAgentSpans: agents.map((e) => e.phase),
    });
  });

  test("score_site runs as the grounded capability", async ({ page, evidence }) => {
    evidence.case("spec6-score-site");
    const s = await openWithTestKey(page, "/", scoreScript(`${PROD.origin}/`));
    await s.send(`score ${PROD.origin}/`);
    await expect(s.mount.getByText(/Score result:/).filter({ visible: true }).first()).toBeVisible({ timeout: 90_000 });
    expect(toolNames(s.router.bodies[0]!)).toContain("readiness_specialist");
    const tools = (await traceEvents(page)).filter((e) => e.kind === "tool" && e.phase === "end" && e.tool === "website_score_site");
    expect(tools.length).toBeGreaterThan(0);
    expect(String(tools[0]!.resultPreview)).toMatch(/"ok":true|"status":"(ready|running)"/);
    evidence.record({ scoreCalls: tools.length, firstResult: String(tools[0]!.resultPreview).slice(0, 300) });
  });

  test("a consent card names demo-harbor; declining sends nothing; approving runs harbor_tours in the browser", async ({ page, evidence }) => {
    evidence.case("spec6-consent-peer");
    const s = await openWithTestKey(page, "/conformance");
    await s.send("call harbor_tours");
    const card = s.mount.locator(".ns-consent").last();
    await expect(card).toContainText(PEER_HOST);
    expect(hostsOf(s.requests)).not.toContain(PEER_HOST);
    await card.getByRole("button", { name: "Decline" }).click();
    await expect(s.mount.getByText(/Results:/).filter({ visible: true }).first()).toBeVisible({ timeout: 30_000 });
    expect(hostsOf(s.requests)).not.toContain(PEER_HOST);

    await s.send("call harbor_tours");
    await s.mount.locator(".ns-consent").last().getByRole("button", { name: "Allow", exact: true }).click();
    await expect(s.mount.getByText(HARBOR_FACT).filter({ visible: true }).first()).toBeVisible({ timeout: 30_000 });
    expect(peerRequests(s.requests).length).toBeGreaterThan(0);
    // The peer network ran in this browser: its agents' model requests reached the in-browser router.
    expect(s.router.bodies.some(isPeerHopBody)).toBe(true);
    evidence.record({ peerRequests: peerRequests(s.requests).length, peerModelRequests: s.router.bodies.filter(isPeerHopBody).length });
  });

  test("no request to the peer carries the session cookie or a key; the router stays the caller's", async ({ page, context, evidence }) => {
    evidence.case("spec6-peer-no-cookie-or-key");
    const s = await openWithTestKey(page, "/conformance");
    // Hold a real Retrofit session cookie in this browser, so the check covers it.
    const session = await page.evaluate(async () => (await fetch("/api/inference/session", { method: "POST", credentials: "same-origin" })).status);
    expect(session).toBe(200);
    // The session cookie is scoped to Path=/api/inference, so ask for it at that path.
    const cookieNames = (await context.cookies(`${PROD.origin}/api/inference/session`)).map((c) => c.name);
    expect(cookieNames).toContain("retrofit_session");
    await s.send("call harbor_tours");
    await s.mount.locator(".ns-consent").last().getByRole("button", { name: "Allow", exact: true }).click();
    await expect(s.mount.getByText(HARBOR_FACT).filter({ visible: true }).first()).toBeVisible({ timeout: 30_000 });
    const toPeer = peerRequests(s.requests);
    expect(toPeer.length).toBeGreaterThan(0);
    for (const r of toPeer) {
      const h = await r.allHeaders();
      expect(h["cookie"]).toBeUndefined();
      expect(h["authorization"]).toBeUndefined();
      expect(JSON.stringify(h)).not.toContain(OTARI.key);
      expect(r.url()).not.toContain(OTARI.key);
      expect(r.postData() ?? "").not.toContain(OTARI.key);
    }
    // The router stays the caller's: the peer hop's model requests went to the caller's router with the caller's key,
    // and nothing went to Retrofit's free router or any other model host.
    expect(s.router.bodies.some(isPeerHopBody)).toBe(true);
    expect(s.router.authorizations.length).toBeGreaterThan(0);
    expect(s.router.authorizations.every((a) => a === `Bearer ${OTARI.key}`)).toBe(true);
    expect(freeChatRequests(s.requests)).toEqual([]);
    const webHosts = new Set(s.requests.filter((r) => /^https?:/.test(r.url())).map((r) => new URL(r.url()).host));
    expect([...webHosts].filter((h) => ![PROD.host, PEER_HOST, OTARI_HOST].includes(h))).toEqual([]);
    evidence.record({ cookieNamesHeld: cookieNames, peerRequests: toPeer.length, routerHost: OTARI_HOST });
  });

  test("the caller's unallowed sly_data field is absent from the peer invocation", async ({ page, evidence }) => {
    evidence.case("spec6-sly-data-filtered");
    const s = await openWithTestKey(page, "/conformance");
    await s.send("call harbor_tours");
    await s.mount.locator(".ns-consent").last().getByRole("button", { name: "Allow", exact: true }).click();
    await expect(s.mount.getByText(HARBOR_FACT).filter({ visible: true }).first()).toBeVisible({ timeout: 30_000 });
    const call = (await traceEvents(page)).find((e) => e.kind === "remote_call" && e.phase === "start");
    expect(call).toBeTruthy();
    const sly = JSON.stringify((call!.requestPayload as Record<string, unknown> | undefined)?.sly_data ?? {});
    expect(sly).not.toContain(CALLER_PRIVATE_SLY_KEY);
    for (const r of peerRequests(s.requests)) expect(`${r.url()} ${r.postData() ?? ""}`).not.toContain(CALLER_PRIVATE_SLY_KEY);
    evidence.record({ peerSlyDataKeys: Object.keys(JSON.parse(sly) as Record<string, unknown>) });
  });

  test("harbor_invalid shows the invalid-network error", async ({ page, evidence }) => {
    evidence.case("spec6-invalid-network");
    const s = await openWithTestKey(page, "/conformance");
    await s.send("call harbor_invalid");
    await s.mount.locator(".ns-consent").last().getByRole("button", { name: "Allow", exact: true }).click();
    await expect(s.notices.locator('[data-kind="error"]')).toContainText("missing_specialist", { timeout: 30_000 });
    evidence.record({ notice: ((await s.notices.locator('[data-kind="error"]').first().textContent()) ?? "").slice(0, 300) });
  });

  test("harbor_loop: no back-edge tool in the peer hop, no second fetch of retrofit_conformance, the loop notice is visible", async ({ page, evidence }) => {
    evidence.case("spec6-cycle-prevention");
    const s = await openWithTestKey(page, "/conformance");
    const before = s.requests.filter(isConformanceFetch).length;
    await s.send("call harbor_loop");
    await s.mount.locator(".ns-consent").last().getByRole("button", { name: "Allow", exact: true }).click();
    await expect(s.notices.locator('[data-kind="loop"]')).toContainText(LOOP_NOTICE, { timeout: 30_000 });
    await expect(s.mount.getByText(/Results:/).filter({ visible: true }).first()).toBeVisible({ timeout: 30_000 });
    // The hop happened, and its model request offered no tool for the call back.
    const hop = s.router.bodies.filter(isLoopHop);
    expect(hop.length).toBeGreaterThan(0);
    for (const b of hop) expect(toolNames(b)).not.toContain("retrofit_conformance");
    // Retrofit's network was not fetched again during the hop.
    expect(s.requests.filter(isConformanceFetch).length).toBe(before);
    const skip = (await traceEvents(page)).find((e) => e.kind === "composition_skip");
    expect(skip?.reason).toBe("already visited in this request");
    // An unknown-tool error is not evidence of loop prevention.
    await expect(s.notices.locator('[data-kind="error"]')).toHaveCount(0);
    evidence.record({ hopModelRequests: hop.length, conformanceFetchesBeforeHop: before, notice: LOOP_NOTICE });
  });

  test("peer calls over the runtime's per-message limits show the over-budget error", async ({ page, evidence }) => {
    evidence.case("spec6-over-budget");
    const s = await openWithTestKey(page, "/conformance");
    // Two calls to the same partner in one message: the runtime allows 1 per partner (4 in total).
    await s.send("call harbor_tours harbor_tours");
    await s.mount.locator(".ns-consent").last().getByRole("button", { name: "Always allow" }).click();
    await expect(s.notices.locator('[data-kind="limit"]')).toContainText("reached the runtime's limit", { timeout: 30_000 });
    const starts = (await traceEvents(page)).filter((e) => e.kind === "remote_call" && e.phase === "start");
    evidence.record({ remoteCallStarts: starts.length, notice: ((await s.notices.locator('[data-kind="limit"]').first().textContent()) ?? "").slice(0, 300) });
  });

  test("the demo-denied tool shows the denied-origin error and no request reaches that host", async ({ page, evidence }) => {
    evidence.case("spec6-denied-origin");
    const s = await openWithTestKey(page, "/conformance");
    await s.send("call none");
    await s.mount.locator(".ns-consent").last().getByRole("button", { name: "Allow", exact: true }).click();
    await expect(s.notices.locator('[data-kind="denied"]')).toContainText(DENIED_HOST, { timeout: 30_000 });
    expect(hostsOf(s.requests)).not.toContain(DENIED_HOST);
    evidence.record({ deniedHost: DENIED_HOST, requestsToDeniedHost: 0 });
  });
});
