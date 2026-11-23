import type { Config } from "@/lib/config";
import { isFixtureHostname, validateUrl } from "@/lib/fetch/url";
import { newToken } from "@/lib/security/tokens";
import { CLAIM_TXT_LABEL } from "./names";

export { CLAIM_META_NAME, CLAIM_TXT_LABEL, CLAIM_TXT_PREFIX } from "./names";

/**
 * The names an ownership claim uses (parent plan, "Ownership claims"). A claim is for one exact
 * host: the host an analysis scored (`URL.host`: lower case, IDN in punycode, a port only when the
 * analysis had a non-default one, which only fixtures mode allows).
 */

/**
 * Fixtures mode only: every claim for a `<label>.fixture.test` host gets this token, so the e2e
 * fixture sites and the fixtures TXT resolver can answer it (src/lib/claims/txt.ts). Fixtures mode
 * is refused on Vercel (loadConfig).
 */
export const FIXTURE_CLAIM_TOKEN = "f1c7e5c1a1a17e57f1c7e5c1a1a17e57";

/** The host of an analysis origin or a saved report's host, normalized as URL.host; null when it is not a bare host. */
export function claimHost(raw: string): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 260 || /[/?#@\\\s]/.test(raw)) return null;
  try {
    const u = new URL(`https://${raw}`);
    return u.host.length > 0 && u.host.length <= 253 ? u.host : null;
  } catch {
    return null;
  }
}

/** The host name without a port. */
export function claimHostname(host: string): string {
  return new URL(`https://${host}`).hostname;
}

/**
 * The home page a meta check reads: `https://<host>/`. Fixtures mode reads a fixture host (which
 * has a port) over http, as its analysis did. Throws NotPublicError when the host is not a public
 * website address.
 */
export function claimPageUrl(host: string, config: Pick<Config, "fixturesEnabled">): URL {
  const scheme = config.fixturesEnabled && /:\d+$/.test(host) ? "http" : "https";
  return validateUrl(`${scheme}://${host}/`, config);
}

/** `_retrofit-verification.<host name>`. */
export function claimRecordName(host: string): string {
  return `${CLAIM_TXT_LABEL}.${claimHostname(host)}`;
}

/** A new claim token (128 random bits in hex), or FIXTURE_CLAIM_TOKEN for a fixture host in fixtures mode. */
export function newClaimToken(host: string, config: Pick<Config, "fixturesEnabled">): string {
  return config.fixturesEnabled && isFixtureHostname(claimHostname(host)) ? FIXTURE_CLAIM_TOKEN : newToken();
}
