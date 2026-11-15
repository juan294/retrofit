import type { Page } from "@playwright/test";
import { expect } from "../fixtures/csp";
import { fixtureOrigin } from "./global-setup";
import { installMockRouter, lastToolResult, systemText, toolNames, type Script } from "./mock-router";

export const OTARI = { routerBase: "https://api.otari.ai/api/v1", model: "alibaba/qwen3.8-flash", key: "otk_test_e2e_0123456789abcdef" };

/**
 * Scripted two-agent turn for a generated preview network: the front agent delegates to
 * content_specialist, which searches the site content; each then answers from the tool result.
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

/** Analyzes a fixture site through the landing form and waits for the score. */
export async function analyzeFixture(page: Page, host: string): Promise<string> {
  await page.goto("/");
  await page.getByLabel("Your website address").fill(fixtureOrigin(host));
  await page.getByRole("button", { name: "Score my site" }).click();
  await expect(page).toHaveURL(/\/r\/[0-9a-f]{32}$/);
  await expect(page.getByTestId("score-total")).toBeVisible({ timeout: 30_000 });
  return new URL(page.url()).pathname.split("/").pop()!;
}

/** Connects the Otari test key through the key panel inside `scope`. */
export async function connectKey(page: Page, key = OTARI.key) {
  await page.getByLabel("Paste your key").fill(key);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByText(/Connected to Otari/)).toBeVisible();
}

export async function mockOtari(page: Page, script: Script = previewScript) {
  return installMockRouter(page, { routerBase: OTARI.routerBase, model: OTARI.model, script });
}
