// When the product's free-analysis limit can exist, for the production evidence: shared by
// tools/release/production-evidence.mjs and the Playwright cases. Plain JavaScript, so the release
// script can import it without a TypeScript loader. tests/release/production-evidence.test.ts keeps
// both values equal to the product's.

/** The earliest BILLING_START the product accepts on Vercel (src/lib/config.ts). */
export const BILLING_STARTS_AT_EARLIEST = Date.parse("2027-01-20T00:00:00Z");

/** The product's answer past the free analyses (src/lib/analysis/texts.ts). */
export const FREE_LIMIT_TEXT = "You've used your 5 free analyses. Sign in to keep going.";

/**
 * True when production may have started billing: only then is the free limit an expected answer. Before, it is a fault.
 *
 * @param {number} [now]
 * @returns {boolean}
 */
export function billingMayHaveStarted(now = Date.now()) {
  return now >= BILLING_STARTS_AT_EARLIEST;
}
