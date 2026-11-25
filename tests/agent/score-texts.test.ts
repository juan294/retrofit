// AS-M2: the published texts about the score (the endpoint description on /bot, the score_site
// description, the guide's instructions and the contract) say the same thing about stored results
// (contract change 19) and API keys (change 18), so they cannot drift from each other or from the code.

import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import BotPage from "@/app/bot/page";
import { agentTexts, SCORE_ENDPOINT_TEXT } from "@/lib/analysis/texts";
import { loadConfig } from "@/lib/config";

const root = fileURLToPath(new URL("../../", import.meta.url));
const read = (path: string) => readFileSync(`${root}${path}`, "utf8");
const contract = read("docs/research/score-tool-contract.md");
const surface1 = contract.slice(contract.indexOf("### Surface 1"), contract.indexOf("### Surface 2"));
const surface2 = contract.slice(contract.indexOf("### Surface 2"));

async function toolDescription(): Promise<string> {
  const mod = (await import(/* @vite-ignore */ pathToFileURL(`${root}public/site-actions.js`).href)) as { scoreSiteAction: () => { description: string } };
  return mod.scoreSiteAction().description;
}

type Agent = { name: string; instructions?: string };
const guide = () => JSON.stringify((JSON.parse(read("public/retrofit_guide.network.json")) as { tools?: Agent[] }).tools ?? null);

describe("the published score texts", () => {
  // Fails if /bot or the tool publishes another text than the contract's.
  it("are the contract's, word for word", async () => {
    expect(surface1).toContain(`"${SCORE_ENDPOINT_TEXT}"`);
    expect(surface2).toContain(`"${await toolDescription()}"`);
    const html = renderToStaticMarkup(createElement(BotPage)).replaceAll("&#x27;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">");
    expect(html).toContain(SCORE_ENDPOINT_TEXT);
  });

  // Change 19. Fails if a text denies that a verified owner's new read can replace a stored result, names another
  // storage time than the code's, or promises that a call can force a new read.
  it("say that a verified owner can replace a stored result sooner, and that no call forces a new read", async () => {
    expect(loadConfig({ SESSION_SECRET: "s".repeat(32) }).crawlCacheTtlS).toBe(24 * 3600);
    for (const text of [SCORE_ENDPOINT_TEXT, await toolDescription()]) {
      expect(text).toMatch(/usually kept for up to 24 hours/);
      expect(text).toMatch(/verified owner can replace it sooner/);
      expect(text).toMatch(/no call can force a new read/i);
    }
    expect(read("src/app/bot/page.tsx")).not.toMatch(/Results are kept for 24 hours/);
    expect(guide()).toMatch(/fetchedAt/);
    expect(guide()).toMatch(/usually kept until cachedUntil, and the site's verified owner can replace it sooner/);
    expect(guide()).toMatch(/to check again, delegate to readiness_specialist again/);
    expect(guide()).not.toMatch(/does not show yet/);
    expect(guide()).toMatch(/Never promise a new read/);
  });

  // Change 18. Fails if an agent with a key has no public description of the header, the server-only rule or the refusals.
  it("describe API keys: the header, servers only, and the refusals", () => {
    expect(SCORE_ENDPOINT_TEXT).toContain("Authorization: Bearer rk_retrofit_");
    expect(SCORE_ENDPOINT_TEXT).toMatch(/Keys are for servers only: never put one in a web page or a browser/);
    for (const refusal of ["401 invalid_key", "403 plan_required", "429 client_limit"]) expect(SCORE_ENDPOINT_TEXT).toContain(refusal);
    expect(SCORE_ENDPOINT_TEXT).toContain("No key, cookie or account is needed.");
  });

  // Fails if a refusal's row is missing from the contract's table, or its status or text differs from the API's.
  it("list every key refusal in the contract's failure table", () => {
    const at = new Date("2026-11-25T00:00:00Z");
    const daily = agentTexts.account_limit(7, 3600, at).replace("7 sites", "{limit} sites").replace("00:00 UTC", "{retryTime} UTC").replace("in 60 minutes", "in {retryMinutes} minutes");
    const hourly = agentTexts.client_limit(7, 3600, at).replace("7 site", "{limit} site").replace("00:00 UTC", "{retryTime} UTC").replace("in 60 minutes", "in {retryMinutes} minutes");
    const rows = surface1.split("\n").filter((line) => line.startsWith("|"));
    for (const [code, status, text] of [["invalid_key", 401, agentTexts.invalid_key], ["plan_required", 403, agentTexts.plan_required], ["client_limit", 429, daily], ["client_limit", 429, hourly]] as const) {
      expect(rows.filter((r) => r.includes(`\`${code}\``) && r.includes(`| ${status} |`) && r.includes(`"${text}"`)), `${code}: ${text}`).toHaveLength(1);
    }
  });
});
