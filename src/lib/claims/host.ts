import type { Config } from "@/lib/config";
import { normalizeHost, originForHost, validateUrl } from "@/lib/fetch/url";
import { CLAIM_TXT_LABEL } from "./names";

/**
 * The names an ownership claim uses (parent plan, "Ownership claims"). A claim is for one exact
 * host: the host an analysis scored (`URL.host`: lower case, IDN in punycode, a port only when the
 * analysis had a non-default one, which only fixtures mode allows).
 */

/** The host of an analysis or a saved report, normalized as an https URL.host (normalizeHost); null when it is not a bare host. */
export function claimHost(raw: string): string | null {
  const host = normalizeHost(raw, "https");
  return host !== null && host.length <= 253 ? host : null;
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
  return validateUrl(`${originForHost(host, config)}/`, config);
}

/** `_retrofit-verification.<host name>`. */
export function claimRecordName(host: string): string {
  return `${CLAIM_TXT_LABEL}.${claimHostname(host)}`;
}
