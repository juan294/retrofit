import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "@/lib/config";
import { NotPublicError } from "@/lib/fetch/errors";
import { guardedLookup, isBlockedAddress, resolvePublic, type Resolver } from "@/lib/fetch/guard";
import cases from "../fixtures/address-cases.json";

const secret = "x".repeat(32);
const prod = loadConfig({ SESSION_SECRET: secret });
const fixtures = loadConfig({ SESSION_SECRET: secret, RETROFIT_TEST_FIXTURES: "1" });

const rows = cases as Array<{ address: string; blocked: boolean; range: string }>;

describe("isBlockedAddress", () => {
  // Guards the table size the plan requires.
  it("has at least 40 address rows", () => {
    expect(rows.length).toBeGreaterThanOrEqual(40);
  });

  // Each row fails if its range is removed from (or wrongly added to) the block list,
  // or if IPv4-mapped IPv6 stops being unwrapped before the IPv4 check.
  it.each(rows.map((r) => [r.address, r.range, r.blocked] as const))("%s (%s) -> blocked %s", (address, _range, blocked) => {
    expect(isBlockedAddress(address)).toBe(blocked);
  });
});

function resolverOf(table: Record<string, string[]>): Resolver & { calls: string[] } {
  const calls: string[] = [];
  const fn = async (hostname: string) => {
    calls.push(hostname);
    const list = table[hostname];
    if (!list) throw Object.assign(new Error(`ENOTFOUND ${hostname}`), { code: "ENOTFOUND" });
    return list.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  };
  return Object.assign(fn, { calls });
}

describe("resolvePublic", () => {
  // Fails if resolvePublic stops returning the checked public addresses.
  it("returns every address when all are public", async () => {
    const r = resolverOf({ "example.com": ["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"] });
    await expect(resolvePublic("example.com", prod, r)).resolves.toEqual(["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"]);
  });

  // Fails if only the first address is checked (a resolver can mix public and private answers).
  it("refuses when any one address is blocked", async () => {
    const r = resolverOf({ "mixed.example.com": ["93.184.216.34", "10.0.0.7"] });
    await expect(resolvePublic("mixed.example.com", prod, r)).rejects.toBeInstanceOf(NotPublicError);
  });

  // Fails if a DNS failure is passed through as a raw error instead of a not-public refusal.
  it("maps a resolution failure to NotPublicError", async () => {
    await expect(resolvePublic("missing.example.com", prod, resolverOf({}))).rejects.toBeInstanceOf(NotPublicError);
  });

  // Fails if loopback becomes allowed in production.
  it("refuses loopback in production", async () => {
    const r = resolverOf({ "evil.example.com": ["127.0.0.1"] });
    await expect(resolvePublic("evil.example.com", prod, r)).rejects.toBeInstanceOf(NotPublicError);
    await expect(resolvePublic("127.0.0.1", prod, r)).rejects.toBeInstanceOf(NotPublicError);
  });

  // Fails if fixtures mode stops allowing loopback, or starts allowing other private ranges.
  it("allows only loopback in fixtures mode", async () => {
    const r = resolverOf({ "evil.example.com": ["10.0.0.1"], "lo.example.com": ["127.0.0.1"] });
    await expect(resolvePublic("127.0.0.1", fixtures, r)).resolves.toEqual(["127.0.0.1"]);
    await expect(resolvePublic("lo.example.com", fixtures, r)).resolves.toEqual(["127.0.0.1"]);
    await expect(resolvePublic("evil.example.com", fixtures, r)).rejects.toBeInstanceOf(NotPublicError);
  });

  // Fails if *.fixture.test maps to loopback in production, or if the mapping calls the real resolver.
  it("maps <label>.fixture.test to 127.0.0.1 only with fixtures enabled", async () => {
    const r = resolverOf({});
    await expect(resolvePublic("bakery.fixture.test", fixtures, r)).resolves.toEqual(["127.0.0.1"]);
    expect(r.calls).toEqual([]);
    await expect(resolvePublic("bakery.fixture.test", prod, r)).rejects.toBeInstanceOf(NotPublicError);
  });
});

describe("guardedLookup", () => {
  function call(lookup: ReturnType<typeof guardedLookup>, host: string, options: { all?: boolean }) {
    return new Promise<{ err: Error | null; address: unknown; family: unknown }>((resolve) => {
      lookup(host, options, (err, address, family) => resolve({ err, address, family }));
    });
  }

  // Fails if guardedLookup ignores `all: true`, which net uses for autoSelectFamily.
  it("returns all addresses when options.all is set", async () => {
    const lookup = guardedLookup(prod, resolverOf({ "example.com": ["93.184.216.34", "2606:4700:4700::1111"] }));
    const out = await call(lookup, "example.com", { all: true });
    expect(out.err).toBeNull();
    expect(out.address).toEqual([
      { address: "93.184.216.34", family: 4 },
      { address: "2606:4700:4700::1111", family: 6 },
    ]);
  });

  // Fails if the single-address callback form is broken.
  it("returns one address and its family otherwise", async () => {
    const lookup = guardedLookup(prod, resolverOf({ "example.com": ["93.184.216.34"] }));
    const out = await call(lookup, "example.com", {});
    expect(out).toEqual({ err: null, address: "93.184.216.34", family: 4 });
  });

  // Fails if the connect-time lookup stops refusing blocked answers.
  it("passes NotPublicError to the callback when any address is blocked", async () => {
    const lookup = guardedLookup(prod, resolverOf({ "evil.example.com": ["93.184.216.34", "169.254.169.254"] }));
    const out = await call(lookup, "evil.example.com", { all: true });
    expect(out.err).toBeInstanceOf(NotPublicError);
  });

  // Fails if the lookup resolves through the system resolver even when a resolver is injected.
  it("uses the injected resolver", async () => {
    const r = vi.fn(async () => [{ address: "1.1.1.1", family: 4 }]);
    const lookup = guardedLookup(prod, r);
    await call(lookup, "one.example.com", {});
    expect(r).toHaveBeenCalledWith("one.example.com");
  });
});
