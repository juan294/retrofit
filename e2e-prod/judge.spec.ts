// The judge path in production (phase-7.md, "Production evidence (step 12)"): the /judges page
// with the judge code gives the session pool "judge". JUDGE_CODE comes from the environment and
// is never written to evidence. The code is typed into the page and a trace would record it, so
// this file runs without traces (screenshots and video are off by default).
import { test, expect } from "./fixtures/csp";

test.use({ trace: "off" });

test("/judges with the code gives pool: judge", async ({ page, evidence }) => {
  evidence.case("judge-path");
  const code = process.env.JUDGE_CODE?.trim();
  expect(code, "JUDGE_CODE must be set in the environment").toBeTruthy();
  await page.goto("/judges");
  await page.getByLabel("Judge code").fill(code!);
  await page.getByRole("button", { name: "Turn on judge access" }).click();
  await expect(page.getByText("Judge access is on for this browser.")).toBeVisible({ timeout: 30_000 });
  const status = await page.evaluate(async () => (await fetch("/api/inference/status", { credentials: "same-origin" })).json());
  expect((status as { pool?: unknown }).pool).toBe("judge");
  evidence.record({ pool: "judge" });
});
