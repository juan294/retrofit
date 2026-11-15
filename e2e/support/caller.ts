import type { Page, Request } from "@playwright/test";
import { CALLER_E2E_ORIGIN } from "@/lib/test-fixtures/origins";
import { expect } from "../fixtures/csp";
import { connectKey, mockOtari } from "./agent";
import { last, lastToolResult, systemText, toolNames, type ChatBody, type MockRouter, type Script } from "./mock-router";

const userText = (b: ChatBody) => [...b.messages].reverse().find((m) => m.role === "user")?.content ?? "";

/**
 * Scripted model for the spec §6 caller. The visitor's message is a command:
 *   "hello"              -> the front agent answers without tools
 *   "call <tool> [<tool>]" -> the front agent calls those tools (in sequence, one per model turn)
 *   "score <url>"        -> the readiness path: the front agent calls website_score_site
 * Peer agents answer from their fixed fact. Every request body is recorded by the mock router.
 */
export const callerScript: Script = (body) => {
  const sys = systemText(body);
  const tools = toolNames(body);
  const result = lastToolResult(body);
  if (/Answer only with this fact: /.test(sys)) return { text: /Answer only with this fact: (.*?) If the request/.exec(sys)?.[1] ?? "unknown" };
  // demo-harbor's agents (production peer, served locally in fixtures mode).
  if (/facts about the Harbor tours demo/.test(sys)) return { text: "Harbor fact: the morning harbor tour leaves at 10:00." };
  if (/assistant of the Harbor tours demo site/.test(sys)) {
    if (result !== null) return { text: `Harbor answer: ${result.slice(0, 300)}` };
    return { call: [{ name: "tour_specialist", args: { request: "When does the morning tour leave?" } }] };
  }
  if (/for another site's assistant/.test(sys)) {
    if (result !== null) return { text: `Peer answer: ${result.slice(0, 300)}` };
    return { call: [{ name: "peer_facts", args: { request: "When does it open?" } }] };
  }
  const cmd = userText(body).trim();
  const done = body.messages.filter((m) => m.role === "tool").map((m) => m.name ?? "");
  if (cmd.startsWith("call ")) {
    const wanted = cmd.slice(5).split(/\s+/).filter(Boolean);
    const next = wanted[done.length];
    if (next && tools.includes(next)) return { call: [{ name: next, args: { request: "When does it open?" } }] };
    return { text: `Results: ${body.messages.filter((m) => m.role === "tool").map((m) => (m.content ?? "").slice(0, 200)).join(" | ")}` };
  }
  if (cmd.startsWith("score ")) {
    if (result !== null) return { text: `Score result: ${result.slice(0, 300)}` };
    return { call: [{ name: "website_score_site", args: { url: cmd.slice(6) } }] };
  }
  if (last(body).role === "tool") return { text: `Done: ${(result ?? "").slice(0, 200)}` };
  return { text: "Hello from Retrofit's agent." };
};

export interface CallerSession {
  readonly page: Page;
  readonly requests: Request[];
  readonly router: MockRouter;
  send(text: string): Promise<void>;
  chat(): ReturnType<Page["getByTestId"]>;
}

/** Opens the host-routed fixture caller, connects the Otari test key and returns a chat driver. */
export async function openCaller(page: Page, origin = CALLER_E2E_ORIGIN, script: Script = callerScript): Promise<CallerSession> {
  const requests: Request[] = [];
  page.on("request", (r) => requests.push(r));
  // Test-only shim: the http fixture callers are not secure contexts, so crypto.randomUUID is
  // missing; the runtime calls it for site actions (runner.js:358). Production origins are HTTPS.
  await page.addInitScript(() => {
    if (typeof crypto.randomUUID !== "function") {
      Object.defineProperty(crypto, "randomUUID", {
        value: () => {
          const b = crypto.getRandomValues(new Uint8Array(16));
          b[6] = (b[6]! & 0x0f) | 0x40;
          b[8] = (b[8]! & 0x3f) | 0x80;
          const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
          return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}` as `${string}-${string}-${string}-${string}-${string}`;
        },
      });
    }
  });
  const router = await mockOtari(page, script);
  await page.goto(`${origin}/`);
  await connectKey(page);
  const mount = page.getByTestId("preview-mount");
  await expect(mount.locator('[data-ns-slot="chat"]')).toBeVisible();
  return {
    page,
    requests,
    router,
    chat: () => page.getByTestId("preview-mount"),
    async send(text: string) {
      const input = mount.getByRole("textbox").last();
      await input.fill(text);
      await input.press("Enter");
    },
  };
}

export const hostsOf = (requests: Request[]) => requests.map((r) => new URL(r.url()).host);
