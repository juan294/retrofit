import { PUBLIC_ORIGIN } from "./server-deps";

/** Test-only ops secrets and the alert issue endpoint (`ALERT_GITHUB_TOKEN` opens issues there). */
export const CRON_SECRET = "cron-secret-0123456789abcdef";
export const GITHUB_TOKEN = "ghp_testtoken0123456789ABCDEFGHIJ";
export const ISSUES_URL = "https://api.github.com/repos/juan294/retrofit/issues";

/** GET /api/cron/credit-check with `auth` as the Authorization header; null sends none. */
export function cronRequest(auth: string | null = `Bearer ${CRON_SECRET}`): Request {
  const headers = new Headers();
  if (auth !== null) headers.set("authorization", auth);
  return new Request(`${PUBLIC_ORIGIN}/api/cron/credit-check`, { headers });
}
