import { promises as dns } from "node:dns";
import type { LookupAddress } from "node:dns";
import type { LookupFunction } from "node:net";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";
import type { Config } from "@/lib/config";
import { NotPublicError } from "./errors";
import { isFixtureHostname } from "./url";

/** Resolves a host name to every address. Injectable so tests never use real DNS. */
export type Resolver = (hostname: string) => Promise<ReadonlyArray<{ address: string; family: number }>>;

export const systemResolver: Resolver = (hostname) => dns.lookup(hostname, { all: true, verbatim: true });

type GuardConfig = Pick<Config, "fixturesEnabled">;

const BLOCKED_V4 = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.0.2.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "224.0.0.0/4",
  "240.0.0.0/4",
].map((c) => ipaddr.IPv4.parseCIDR(c));

const BLOCKED_V6 = [
  "::/128",
  "::1/128",
  "fc00::/7",
  "fe80::/10",
  "ff00::/8",
  "2001:db8::/32",
  "2001::/32",
  "2002::/16",
  "64:ff9b::/96",
  "64:ff9b:1::/48",
].map((c) => ipaddr.IPv6.parseCIDR(c));

/** Global unicast. Anything outside it is unallocated or special-purpose and is refused as well. */
const GLOBAL_UNICAST_V6 = ipaddr.IPv6.parseCIDR("2000::/3");

/**
 * True when the address is not a public unicast address (see the Phase 2
 * range list). IPv4-mapped IPv6 (::ffff:0:0/96) is checked as its IPv4
 * address. Unparseable input is blocked.
 */
export function isBlockedAddress(ip: string): boolean {
  if (!ipaddr.isValid(ip)) return true;
  let addr = ipaddr.parse(ip);
  if (addr.kind() === "ipv6" && (addr as ipaddr.IPv6).isIPv4MappedAddress()) addr = (addr as ipaddr.IPv6).toIPv4Address();
  if (addr.kind() === "ipv4") {
    const v4 = addr as ipaddr.IPv4;
    return BLOCKED_V4.some((range) => v4.match(range));
  }
  const v6 = addr as ipaddr.IPv6;
  return !v6.match(GLOBAL_UNICAST_V6) || BLOCKED_V6.some((range) => v6.match(range));
}

function isLoopback(ip: string): boolean {
  if (!ipaddr.isValid(ip)) return false;
  let addr = ipaddr.parse(ip);
  if (addr.kind() === "ipv6" && (addr as ipaddr.IPv6).isIPv4MappedAddress()) addr = (addr as ipaddr.IPv6).toIPv4Address();
  return addr.range() === "loopback";
}

function allowed(ip: string, config: GuardConfig): boolean {
  return !isBlockedAddress(ip) || (config.fixturesEnabled && isLoopback(ip));
}

async function resolveChecked(hostname: string, config: GuardConfig, resolver: Resolver): Promise<LookupAddress[]> {
  const bare = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  let addresses: LookupAddress[];
  const literal = isIP(bare);
  if (literal !== 0) {
    addresses = [{ address: bare, family: literal }];
  } else if (config.fixturesEnabled && isFixtureHostname(bare.toLowerCase())) {
    addresses = [{ address: "127.0.0.1", family: 4 }];
  } else {
    try {
      addresses = (await resolver(bare)).map(({ address, family }) => ({ address, family }));
    } catch {
      throw new NotPublicError(`${bare} did not resolve`);
    }
  }
  if (addresses.length === 0) throw new NotPublicError(`${bare} did not resolve`);
  for (const { address } of addresses) {
    if (!allowed(address, config)) throw new NotPublicError(`${bare} resolves to a non-public address`);
  }
  return addresses;
}

/**
 * Resolves `hostname` and returns every address, refusing with NotPublicError
 * when any address is blocked. With fixtures enabled, loopback is allowed and
 * `<label>.fixture.test` resolves to 127.0.0.1 without DNS.
 */
export async function resolvePublic(hostname: string, config: GuardConfig, resolver: Resolver = systemResolver): Promise<string[]> {
  return (await resolveChecked(hostname, config, resolver)).map((a) => a.address);
}

/**
 * A `net.connect` / undici `connect.lookup` function that applies the same
 * checks as `resolvePublic` at connect time, so a socket only opens to an
 * address that was checked in that same lookup (DNS rebinding defence).
 */
export function guardedLookup(config: GuardConfig, resolver: Resolver = systemResolver): LookupFunction {
  return (hostname, options, callback) => {
    resolveChecked(hostname, config, resolver).then(
      (addresses) => {
        if (options.all) {
          callback(null, addresses);
          return;
        }
        const first = addresses[0] as LookupAddress;
        callback(null, first.address, first.family);
      },
      (err: Error) => callback(err as NodeJS.ErrnoException, "", 0),
    );
  };
}
