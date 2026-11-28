import { isIP } from "node:net";
import { parse as parseDomain } from "tldts";
import type { Config } from "@/lib/config";
import { NotPublicError } from "./errors";

export const MAX_URL_LENGTH = 2048;

/** A lower-case DNS name of ASCII labels (punycode), with an optional port. */
const HOST = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*(?::\d{1,5})?$/;

/** True for a host already in normalized form (normalizeHost's output) of at most 253 characters. */
export function isNormalizedHost(host: string): boolean {
  return host.length <= 253 && HOST.test(host);
}

/**
 * The host as URL.host for `scheme` (lower case, IDN in punycode, the scheme's default port dropped),
 * or null when it is not a plain DNS name with an optional port: no path, query, fragment or
 * credentials, no whitespace or control characters.
 */
export function normalizeHost(host: string, scheme: "http" | "https" = "http"): string | null {
  // Whitespace and control characters first: the URL parser would silently strip tabs and newlines.
  // eslint-disable-next-line no-control-regex -- matching control characters is the point of this check
  if (host.length === 0 || host.length > 260 || /[\u0000-\u0020\u007f-\u009f]/.test(host)) return null;
  let parsed: URL;
  try {
    parsed = new URL(`${scheme}://${host}`);
  } catch {
    return null;
  }
  if (parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.username || parsed.password || !HOST.test(parsed.host)) return null;
  return parsed.host;
}

/** The origin a host is read at: `https://<host>`, or http for a fixture host with a port in fixtures mode (as its analysis was). */
export function originForHost(host: string, config: Pick<Config, "fixturesEnabled">): string {
  return `${config.fixturesEnabled && /:\d+$/.test(host) ? "http" : "https"}://${host}`;
}

const FIXTURE_HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.fixture\.test$/;

/** True for one-label `<label>.fixture.test` names, which `guardedLookup` maps to loopback when fixtures are enabled. */
export function isFixtureHostname(hostname: string): boolean {
  return FIXTURE_HOST.test(hostname);
}

function isFixtureForm(u: URL): boolean {
  if (u.protocol !== "http:" || u.port === "") return false;
  return u.hostname === "127.0.0.1" || u.hostname === "localhost" || isFixtureHostname(u.hostname);
}

/**
 * Accepts only a public website address: http or https, port 80 or 443, no
 * credentials, a DNS name under a public suffix (IDN converted to punycode),
 * at most 2048 characters. Removes the fragment. IP literals are refused.
 * With `fixturesEnabled`, also accepts exactly http://127.0.0.1:<port>,
 * http://localhost:<port> and http://<label>.fixture.test:<port>.
 * Throws NotPublicError.
 */
export function validateUrl(raw: string, config: Pick<Config, "fixturesEnabled">): URL {
  const input = raw.trim();
  if (input.length === 0) throw new NotPublicError("empty");
  if (input.length > MAX_URL_LENGTH) throw new NotPublicError("too long");

  let u: URL;
  try {
    u = new URL(input);
  } catch {
    throw new NotPublicError("not a URL");
  }
  u.hash = "";

  if (u.protocol !== "http:" && u.protocol !== "https:") throw new NotPublicError("scheme");
  if (u.username || u.password) throw new NotPublicError("credentials");
  if (u.href.length > MAX_URL_LENGTH) throw new NotPublicError("too long");

  if (config.fixturesEnabled && isFixtureForm(u)) return u;

  if (u.port !== "" && u.port !== "80" && u.port !== "443") throw new NotPublicError("port");

  const hostname = u.hostname;
  if (hostname.startsWith("[") || isIP(hostname) !== 0) throw new NotPublicError("IP literal");

  const info = parseDomain(hostname, { allowPrivateDomains: true });
  if (info.isIp || !info.domain || !(info.isIcann || info.isPrivate)) throw new NotPublicError("no public suffix");

  return u;
}
