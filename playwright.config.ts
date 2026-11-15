import { defineConfig, devices } from "@playwright/test";

export const BASE_URL = "http://127.0.0.1:3010";

export default defineConfig({
  testDir: "e2e",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  retries: 0,
  reporter: [["list"], ["json", { outputFile: ".local/evidence/current/playwright.json" }]],
  outputDir: ".local/playwright/results",
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: { args: ['--host-resolver-rules=MAP *.fixture.test 127.0.0.1'] },
      },
    },
  ],
  webServer: {
    command: "pnpm start",
    url: `${BASE_URL}/`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: { RETROFIT_TEST_FIXTURES: "1", PUBLIC_ORIGIN: BASE_URL },
  },
});
