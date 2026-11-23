import type { Locator, Page } from "@playwright/test";
import { expect } from "../fixtures/csp";
import { fixtureOrigin } from "./global-setup";
import { installMockRouter, lastToolResult, systemText, toolNames, type Script } from "./mock-router";
import { OTARI_ROUTER_ORIGIN } from "./router-origin";

export const OTARI = { routerBase: `${OTARI_ROUTER_ORIGIN}/api/v1`, model: "alibaba/qwen3.8-flash", key: "otk_test_e2e_0123456789abcdef" };

/**
 * Scripted turn for a generated preview network: the agent searches the site content, then answers
 * from the tool result. A network with a content_specialist (Retrofit's own and peer networks) delegates first.
 */
export const previewScript: Script = (body) => {
  const result = lastToolResult(body);
  const tools = toolNames(body);
  if (result !== null) {
    // Answer like a model would: quote the hours sentence and its source link from the tool result.
    const plain = result.replace(/\\+"/g, '"');
    const hours = /Our opening hours are [^."\\]*/.exec(plain)?.[0] ?? "I could not find the hours.";
    // The specialist sees the search result ("url" field); the front agent sees the specialist's answer (a Markdown link).
    const source = /"url":"(https?:[^"]+)"/.exec(plain)?.[1] ?? /\]\((https?:[^)]+)\)/.exec(plain)?.[1] ?? "";
    return { text: `${hours}. Source: [${source}](${source})` };
  }
  if (tools.includes("content_specialist")) return { call: [{ name: "content_specialist", args: { request: "opening hours" } }] };
  if (/content_specialist|snapshot/i.test(systemText(body)) && tools.includes("website_search_site_content")) {
    return { call: [{ name: "website_search_site_content", args: { query: "opening hours" } }] };
  }
  return { text: "No tools." };
};

/** Analyzes a fixture site through the landing form and waits for the score (or for `settled`, such as a failure text). */
export async function analyzeFixture(page: Page, host: string, settled: (page: Page) => Locator = (p) => p.getByTestId("score-total")): Promise<string> {
  await page.goto("/");
  await page.getByLabel("Your website address").fill(fixtureOrigin(host));
  await page.getByRole("button", { name: "Score my site" }).click();
  await expect(page).toHaveURL(/\/r\/[0-9a-f]{32}$/);
  await expect(settled(page)).toBeVisible({ timeout: 30_000 });
  return new URL(page.url()).pathname.split("/").pop()!;
}

/**
 * Opens the key form. While the free AI works, the form sits in a closed "Use your own AI key" disclosure;
 * wait until the free path has settled (free AI on, a key connected, or the free AI refused) before opening it.
 */
export async function openKeyForm(page: Page) {
  await expect(page.getByText("Using Retrofit's free AI").or(page.getByText(/Connected to /)).or(page.getByTestId("free-banner")).first()).toBeVisible({ timeout: 20_000 });
  const disclosure = page.getByTestId("own-key");
  if (!(await disclosure.evaluate((d) => (d as HTMLDetailsElement).open))) await disclosure.locator(":scope > summary").click();
}

/** Connects the Otari test key through the key panel inside `scope`. */
export async function connectKey(page: Page, key = OTARI.key) {
  await openKeyForm(page);
  await page.getByLabel("Paste your key").fill(key);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByText(/Connected to Otari/)).toBeVisible();
}

export async function mockOtari(page: Page, script: Script = previewScript) {
  return installMockRouter(page, { routerBase: OTARI.routerBase, model: OTARI.model, script });
}

/** The events the runtime recorded in its trace (`window.__nsweb.trace`). */
export async function traceEvents(page: Page): Promise<Record<string, unknown>[]> {
  return page.evaluate(() => {
    const w = window as unknown as { __nsweb?: { trace: { events: Record<string, unknown>[] } } };
    return JSON.parse(JSON.stringify(w.__nsweb?.trace.events ?? []));
  });
}
