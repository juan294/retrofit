/** A complete Vercel environment for configuration tests (synthetic values only). */
export const VERCEL_ENV: Record<string, string> = {
  VERCEL: "1",
  SESSION_SECRET: "s".repeat(32),
  PUBLIC_ORIGIN: "https://retrofit.example",
  FREE_PRICE_IN_PER_M: "0.05",
  FREE_PRICE_OUT_PER_M: "0.2",
  FREE_CREDIT_USD: "100",
  JUDGE_RESERVE_USD: "30",
  OTARI_API_KEY: "otk_server_test",
  JUDGE_CODE: "judge-code-test",
  CRON_SECRET: "cron-secret-test",
  ALERT_GITHUB_TOKEN: "github-token-test",
};
