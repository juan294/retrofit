// Production evidence run (phase-7.md, "Production evidence (step 12)"). Run only by
// tools/release/production-evidence.mjs after an authorized deployment: it contacts the
// production deployment. No webServer and no globalSetup: nothing local is started.
// The root playwright.config.ts (testDir "e2e") never picks up this directory.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const PROD_URL = (process.env.RETROFIT_PROD_URL?.trim() || "https://retrofit.thecreativetoken.com").replace(/\/+$/, "");

export default defineConfig({
  // Paths in a config resolve against its own directory, so they are made absolute from the root.
  testDir: path.join(ROOT, "e2e-prod"),
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  // Production failures are reported, never rerun (phase-7.md step 13).
  retries: 0,
  timeout: 120_000,
  reporter: [["list"], ["json", { outputFile: path.join(ROOT, ".local", "evidence", "production", "playwright-prod.json") }]],
  outputDir: path.join(ROOT, ".local", "playwright", "prod-results"),
  use: {
    baseURL: PROD_URL,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
