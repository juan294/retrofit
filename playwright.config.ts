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
  globalSetup: "./e2e/support/global-setup.ts",
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: {
          args: [
            "--host-resolver-rules=MAP *.fixture.test 127.0.0.1",
          ],
        },
      },
    },
  ],
  webServer: {
    command: "pnpm start",
    url: `${BASE_URL}/`,
    reuseExistingServer: false,
    timeout: 60_000,
    // One client IP runs every spec, so the hourly analysis, notify and sign-in limits are raised for the test server only.
    // Free path: a mock upstream on the 3013 test server, a test server key and a test judge code.
    env: {
      RETROFIT_TEST_FIXTURES: "1",
      PUBLIC_ORIGIN: BASE_URL,
      ANALYSES_PER_CLIENT_HOUR: "1000",
      // The notify limit (5 an hour per network) has unit tests; every spec shares one client IP here.
      NOTIFY_PER_CLIENT_HOUR: "1000",
      // The sign-in limits (5 links per network, 3 per address an hour) have unit tests; every spec shares one client IP.
      SIGNIN_PER_CLIENT_HOUR: "1000",
      SIGNIN_PER_EMAIL_HOUR: "1000",
      FREE_UPSTREAM_URL: "http://127.0.0.1:3013/otari/v1",
      OTARI_API_KEY: "otk_server_e2e_only",
      JUDGE_CODE: "judge-code-e2e",
      FREE_CALLS_PER_SESSION: "12",
      FREE_SESSIONS_PER_CLIENT_HOUR: "1000",
    },
  },
});
