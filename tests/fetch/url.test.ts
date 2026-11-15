import { describe, expect, it } from "vitest";
import { NotPublicError } from "@/lib/fetch/errors";
import { validateUrl } from "@/lib/fetch/url";

const prod = { fixturesEnabled: false } as const;
const fixtures = { fixturesEnabled: true } as const;

function refused(raw: string, config: { fixturesEnabled: boolean }) {
  try {
    validateUrl(raw, config);
  } catch (e) {
    return e;
  }
  return undefined;
}

describe("validateUrl production refusals", () => {
  // Each row fails if validateUrl stops refusing that class of input
  // (for example, dropping the credential, scheme, port, IP-literal or public-suffix check).
  const cases: Array<[string, string]> = [
    ["credentials", "https://user:pass@example.com/"],
    ["username only", "https://user@example.com/"],
    ["ftp scheme", "ftp://example.com/file"],
    ["javascript scheme", "javascript:alert(1)"],
    ["file scheme", "file:///etc/passwd"],
    ["port 8080", "https://example.com:8080/"],
    ["port 22", "http://example.com:22/"],
    ["IPv4 literal", "http://93.184.216.34/"],
    ["loopback literal", "http://127.0.0.1/"],
    ["decimal IPv4 literal", "http://2130706433/"],
    ["hex IPv4 literal", "http://0x7f.0.0.1/"],
    ["IPv6 literal", "http://[2606:4700:4700::1111]/"],
    ["IPv6 loopback literal", "http://[::1]/"],
    ["no public suffix", "https://intranet/"],
    ["unknown suffix", "https://foo.notatld/"],
    ["bare public suffix", "https://co.uk/"],
    ["localhost", "http://localhost/"],
    ["fixture host", "http://bakery.fixture.test/"],
    ["fixture host with port", "http://bakery.fixture.test:4000/"],
    ["loopback with port", "http://127.0.0.1:4000/"],
    ["not a URL", "not a url"],
    ["empty", ""],
  ];
  it.each(cases)("refuses %s", (_name, raw) => {
    expect(refused(raw, prod)).toBeInstanceOf(NotPublicError);
  });

  // Fails if the error loses its stable code, which the UI maps to "This address is not a public website."
  it("refusals carry the not_public code", () => {
    expect((refused("ftp://example.com/", prod) as NotPublicError).code).toBe("not_public");
  });

  // Fails if the 2048-character limit is removed or set off by one.
  it("refuses a URL longer than 2048 characters and accepts one of exactly 2048", () => {
    const base = "https://example.com/";
    const exact = base + "a".repeat(2048 - base.length);
    expect(exact.length).toBe(2048);
    expect(validateUrl(exact, prod).href).toBe(exact);
    expect(refused(exact + "a", prod)).toBeInstanceOf(NotPublicError);
  });
});

describe("validateUrl production acceptance", () => {
  // Fails if http/https with default ports stop being accepted.
  it("accepts http and https on ports 80 and 443", () => {
    expect(validateUrl("https://example.com/menu?x=1", prod).href).toBe("https://example.com/menu?x=1");
    expect(validateUrl("http://example.com:80/", prod).href).toBe("http://example.com/");
    expect(validateUrl("https://example.com:443/", prod).href).toBe("https://example.com/");
  });

  // Fails if the fragment is kept (it would split one page into several cache keys).
  it("removes the fragment", () => {
    expect(validateUrl("https://example.com/a#section", prod).href).toBe("https://example.com/a");
  });

  // Fails if IDN names are not converted to punycode.
  it("converts an IDN host to punycode", () => {
    expect(validateUrl("https://bücher.de/", prod).hostname).toBe("xn--bcher-kva.de");
  });

  // Fails if private public-suffix entries (github.io) or multi-part suffixes stop counting as public.
  it("accepts private and multi-part public suffixes", () => {
    expect(validateUrl("https://someone.github.io/", prod).hostname).toBe("someone.github.io");
    expect(validateUrl("https://shop.example.co.uk/", prod).hostname).toBe("shop.example.co.uk");
  });

  // Fails if surrounding whitespace from a pasted URL is not trimmed.
  it("trims surrounding whitespace", () => {
    expect(validateUrl("  https://example.com/  ", prod).href).toBe("https://example.com/");
  });
});

describe("validateUrl with fixtures enabled", () => {
  // Fails if the fixture forms are not accepted when fixturesEnabled is true.
  it("accepts exactly the three fixture forms", () => {
    expect(validateUrl("http://127.0.0.1:4100/a", fixtures).href).toBe("http://127.0.0.1:4100/a");
    expect(validateUrl("http://localhost:4100/", fixtures).host).toBe("localhost:4100");
    expect(validateUrl("http://bakery.fixture.test:4100/", fixtures).host).toBe("bakery.fixture.test:4100");
  });

  // Fails if the one-label rule is relaxed.
  it("refuses two-label fixture names such as a.b.fixture.test", () => {
    expect(refused("http://a.b.fixture.test:4100/", fixtures)).toBeInstanceOf(NotPublicError);
  });

  // Fails if fixture acceptance widens beyond the exact forms (scheme, port, other loopback or private literals).
  it.each([
    ["https fixture", "https://bakery.fixture.test:4100/"],
    ["fixture without port", "http://bakery.fixture.test/"],
    ["loopback without port", "http://127.0.0.1/"],
    ["other loopback address", "http://127.0.0.2:4100/"],
    ["private literal", "http://10.0.0.1:4100/"],
    ["IPv6 loopback", "http://[::1]:4100/"],
    ["credentials on fixture", "http://u:p@bakery.fixture.test:4100/"],
    ["other .test name", "http://bakery.other.test:4100/"],
  ])("still refuses %s", (_name, raw) => {
    expect(refused(raw, fixtures)).toBeInstanceOf(NotPublicError);
  });

  // Fails if enabling fixtures removes the production refusals.
  it("keeps the production refusals", () => {
    expect(refused("ftp://example.com/", fixtures)).toBeInstanceOf(NotPublicError);
    expect(refused("https://example.com:8080/", fixtures)).toBeInstanceOf(NotPublicError);
    expect(refused("https://intranet/", fixtures)).toBeInstanceOf(NotPublicError);
    expect(validateUrl("https://example.com/", fixtures).href).toBe("https://example.com/");
  });
});
