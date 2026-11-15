import { isIP } from "node:net";
import { parse as parseDomain } from "tldts";
import type { Config } from "@/lib/config";
import { NotPublicError } from "./errors";

export const MAX_URL_LENGTH = 2048;

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
