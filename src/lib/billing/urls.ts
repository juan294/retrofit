/** Stripe's hosted pages: the only places Retrofit ever sends a browser to pay or to manage a plan. */
const HOSTS = new Set(["checkout.stripe.com", "billing.stripe.com"]);
export const FIXTURE_BILLING_PATH = "/test-fixtures/billing/";

/**
 * True for an https URL of a Stripe hosted page, with no credentials and no port. `fixtureOrigin`
 * (fixtures mode only, else null): also the fixtures checkout page on that origin. Checked on the
 * server before a URL is answered and in the browser before it navigates.
 */
export function isBillingUrl(raw: unknown, fixtureOrigin: string | null): raw is string {
  if (typeof raw !== "string" || !URL.canParse(raw)) return false;
  const url = new URL(raw);
  if (url.username || url.password) return false;
  if (fixtureOrigin !== null && url.origin === fixtureOrigin) return url.pathname.startsWith(FIXTURE_BILLING_PATH);
  return url.protocol === "https:" && url.port === "" && HOSTS.has(url.hostname);
}
