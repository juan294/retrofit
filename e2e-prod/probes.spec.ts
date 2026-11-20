// Production probes that need a real browser (phase-7.md, "Production evidence (step 12)"):
// analyzing Retrofit's own site end to end (one real model call on the free path, tagged
// @real-model). The judge path is in judge.spec.ts.
import { test, expect } from "./fixtures/csp";
import { askAndWaitForAnswer, freeChatRequests } from "./support/prod";
import { prodUrl } from "./support/report";

type Request = import("@playwright/test").Request;

const PROD = new URL(prodUrl());
const AGENTIC_WEB_CHECKS = ["aw.manifest", "aw.network-valid", "aw.cors"];

test("analyze Retrofit's own site: score ready, the three agentic-web checks pass, the preview answers on the free path", { tag: "@real-model" }, async ({ page, evidence }) => {
  evidence.case("analyze-own-site");
  test.setTimeout(240_000);
  const requests: Request[] = [];
  page.on("request", (r) => requests.push(r));
  const started = Date.now();
  await page.goto("/");
  await page.getByLabel("Your website address").fill(`${PROD.origin}/`);
  await page.getByRole("button", { name: "Score my site" }).click();
  await expect(page).toHaveURL(/\/r\/[0-9a-f]{32}$/, { timeout: 30_000 });
  await expect(page.getByTestId("score-total")).toBeVisible({ timeout: 150_000 });
  const scoreMs = Date.now() - started;
  const score = Number((await page.getByTestId("score-total").textContent())?.trim());
  for (const id of AGENTIC_WEB_CHECKS) {
    await expect(page.getByTestId(`check-${id}`).locator("strong").first()).toHaveText("pass");
  }
  await expect(page.getByText("Using Retrofit's free AI")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("preview-mount").locator('[data-ns-slot="chat"]')).toBeVisible({ timeout: 30_000 });
  const answer = await askAndWaitForAnswer(page, "What can this site help me with?");
  const chats = freeChatRequests(requests);
  expect(chats.length).toBeGreaterThan(0);
  const statuses = await Promise.all(chats.map(async (r) => (await r.response())?.status() ?? 0));
  expect(statuses.every((s) => s === 200)).toBe(true);
  evidence.record({ analysisId: new URL(page.url()).pathname.split("/").pop(), score, scoreMs, agenticWebChecks: AGENTIC_WEB_CHECKS, realModelCalls: chats.length, answerChars: answer.length });
});
