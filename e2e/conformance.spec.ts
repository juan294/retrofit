import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect } from "./fixtures/csp";
import { RETROFIT_ORIGIN } from "./support/extra-requests";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHECK = path.join(ROOT, "tools", "agentic-web", "scripts", "check_partner.mjs");

test("the organizers' check_partner.mjs accepts Retrofit's own network", async ({ request }) => {
  test.setTimeout(150_000);
  // The test server is up (Playwright webServer) and serves Retrofit's network.
  expect((await request.get("/agent-manifest.json")).status()).toBe(200);

  const run = spawnSync(process.execPath, [CHECK, `${RETROFIT_ORIGIN}/retrofit_guide`], { cwd: ROOT, encoding: "utf8", timeout: 120_000 });
  const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
  const report = `check_partner.mjs exit ${run.status} signal ${run.signal ?? "none"}${run.error ? ` error ${run.error.message}` : ""}\n${output}`;
  if (run.status !== 0) console.log(report);

  expect(run.error, report).toBeUndefined();
  expect(run.status, report).toBe(0);
  const errorLines = output.split("\n").filter((line) => /^\s*(ERROR\b|FAILED\b)/.test(line));
  expect(errorLines, report).toEqual([]);
  expect(output.trim().length, report).toBeGreaterThan(0);
  // The bridge names its action module, so partners get the reads it shares (score_site).
  expect(output, report).toContain(`Its bridge loads ${RETROFIT_ORIGIN}/bridge/bridge-actions.js.`);
  expect(output, report).not.toContain("Its bridge shares no actions");
});
