// Drivers for the production spec §6 cases. Nothing here starts a server: the pages, the peer
// and the guard are the production deployment's, and only the BYOK router (api.otari.ai) is
// scripted inside the test browser by the local mock router (e2e/support/mock-router.ts).
import type { Page, Request } from "@playwright/test";
import { OTARI, mockOtari } from "../../e2e/support/agent";
import { callerScript } from "../../e2e/support/caller";
import { lastToolResult, systemText, toolNames, type MockRouter, type Script } from "../../e2e/support/mock-router";
import { KEY_ITEM } from "@/lib/keys/storage";
import { CONFORMANCE_NETWORK } from "@/lib/peer/conformance";
import { expect } from "../fixtures/csp";
import { prodUrl } from "./report";

/** What the scripted harbor_loop agent answers when the call back is not offered (its own instructions). */
export const LOOP_SKIPPED_ANSWER = "The call back to Retrofit was skipped to prevent a loop.";

/** The model request of harbor_loop's front agent, inside the peer hop. */
export const isLoopHop = (body: Parameters<Script>[0]) => /You exist to test loop prevention/.test(systemText(body));

/**
 * callerScript (e2e/support/caller.ts) plus harbor_loop's agent. If the runtime ever offered the
 * back edge, the scripted loop agent would call it, so the case would see the second fetch.
 */
export const prodScript: Script = (body) => {
  if (isLoopHop(body)) {
    if (toolNames(body).includes(CONFORMANCE_NETWORK)) return { call: [{ name: CONFORMANCE_NETWORK, args: { request: "What do you check?" } }] };
    const result = lastToolResult(body);
    return { text: result === null ? LOOP_SKIPPED_ANSWER : `Loop answer: ${result.slice(0, 200)}` };
  }
  return callerScript(body);
};

/**
 * Scripted landing assistant for score_site: the front agent delegates to readiness_specialist,
 * which calls website_score_site; each answers from the tool result.
 */
export const scoreScript =
  (target: string): Script =>
  (body) => {
    const result = lastToolResult(body);
    if (result !== null) return { text: `Score result: ${result.slice(0, 300)}` };
    const tools = toolNames(body);
    if (tools.includes("website_score_site")) return { call: [{ name: "website_score_site", args: { url: target } }] };
    if (tools.includes("readiness_specialist")) return { call: [{ name: "readiness_specialist", args: { request: `Score ${target}` } }] };
    return { text: "No score tool was offered." };
  };

/**
 * Stores the Otari test key in this tab's key storage before the page runs, as the key panel
 * would after a connect. The page then restores it, so the free path never starts and never
 * counts a free session (FREE_SESSIONS_PER_CLIENT_HOUR is 6 in production).
 */
export async function seedTestKey(page: Page, host: string) {
  const value = JSON.stringify({ provider: "Otari", router: OTARI.routerBase, model: OTARI.model, key: OTARI.key });
  await page.addInitScript(
    ({ item, saved, only }) => {
      if (location.host !== only) return;
      try {
        sessionStorage.setItem(item, saved);
      } catch {
        // Blocked storage: the key panel then shows the connect form and the case fails visibly.
      }
    },
    { item: KEY_ITEM, saved: value, only: host },
  );
}

export interface ProdSession {
  readonly page: Page;
  readonly requests: Request[];
  readonly router: MockRouter;
  readonly mount: ReturnType<Page["getByTestId"]>;
  readonly notices: ReturnType<Page["getByTestId"]>;
  send(text: string): Promise<void>;
}

/** Opens a production page with the scripted BYOK router and the restored test key. */
export async function openWithTestKey(page: Page, pathname: string, script: Script = prodScript): Promise<ProdSession> {
  const requests: Request[] = [];
  page.on("request", (r) => requests.push(r));
  await seedTestKey(page, new URL(prodUrl()).host);
  const router = await mockOtari(page, script);
  await page.goto(pathname);
  await expect(page.getByText(/Connected to Otari/)).toBeVisible({ timeout: 30_000 });
  const mount = page.getByTestId("preview-mount");
  await expect(mount.locator('[data-ns-slot="chat"]')).toBeVisible({ timeout: 30_000 });
  return {
    page,
    requests,
    router,
    mount,
    notices: page.getByTestId("preview-notices"),
    async send(text: string) {
      const input = mount.getByRole("textbox").last();
      await input.fill(text);
      await input.press("Enter");
    },
  };
}

/** Sends a question in the preview chat and waits until a new, non-empty assistant message appears. */
export async function askAndWaitForAnswer(page: Page, text: string, timeout = 90_000): Promise<string> {
  const mount = page.getByTestId("preview-mount");
  const bot = mount.locator(".ns-msg.bot:not(.ns-turn-status)");
  const before = await bot.count();
  const input = mount.getByRole("textbox").last();
  await input.fill(text);
  await input.press("Enter");
  const answer = async () => ((await bot.count()) > before ? ((await bot.last().textContent()) ?? "").trim() : "");
  await expect.poll(async () => (await answer()).length, { timeout }).toBeGreaterThan(0);
  // The answer streams in: wait until it stops changing for two seconds.
  let last = await answer();
  await expect
    .poll(
      async () => {
        await page.waitForTimeout(2_000);
        const now = await answer();
        const settled = now === last;
        last = now;
        return settled;
      },
      { timeout, intervals: [0] },
    )
    .toBe(true);
  return last;
}

/** Production model requests that went to Retrofit's own (free) router. */
export const freeChatRequests = (requests: Request[]) =>
  requests.filter((r) => r.method() === "POST" && new URL(r.url()).pathname === "/api/inference/v1/chat/completions");
