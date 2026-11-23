/**
 * Which paths the request hook (src/proxy.ts) skips: exactly the files that carry their own policy.
 * A skipped path gets no page CSP, so a pattern that is too wide is a security defect.
 */
import { NextRequest } from "next/server";
import { unstable_doesMiddlewareMatch as doesMatch } from "next/experimental/testing/server";
import { describe, expect, it, vi } from "vitest";
import { config, proxy } from "@/proxy";
import { BRIDGE_CSP, staticSecurityHeaders } from "@/lib/security/headers";

// Next's request hook runs where AsyncLocalStorage is a global; plain Node has it in a module.
await vi.hoisted(async () => {
  Object.assign(globalThis, { AsyncLocalStorage: (await import("node:async_hooks")).AsyncLocalStorage });
});

const runs = (url: string) => doesMatch({ config, nextConfig: {}, url });

describe("the request hook's matcher", () => {
  // Fails if a published site's bridge or badge gets the page CSP (the bridge must be frameable, the badge cached).
  it.each(["/s/shop.example.com/bridge/action-bridge.html", "/s/shop.example.com/bridge/agent-manifest.json", "/s/bakery.fixture.test:3011/bridge/action-bridge.html", "/p/0123456789abcdef0123456789abcdef/bridge/action-bridge.html", "/badge/shop.example.com.svg", "/badge/bakery.fixture.test:3011.svg"])(
    "skips %s",
    (url) => {
      expect(runs(url)).toBe(false);
    },
  );

  // Fails if the exclusions cover anything wider: a page, the other agent files, a deeper or dot path, or another route with the same words.
  it.each([
    "/s/shop.example.com",
    "/s/shop.example.com/agent-manifest.json",
    "/s/shop.example.com/content-actions.js",
    "/s/shop.example.com/runtime/action-bridge.js",
    "/s/shop.example.com/bridge",
    "/s/shop.example.com/bridge/",
    "/s/shop.example.com/bridge/a/b.html",
    "/s/shop.example.com/bridge/%2e%2e/%2e%2e/account",
    "/s/shop.example.com/x/bridge/action-bridge.html",
    "/s/bridge/action-bridge.html",
    "/x/s/shop.example.com/bridge/action-bridge.html",
    "/signs/shop.example.com/bridge/action-bridge.html",
    "/badge",
    "/badge/",
    "/badge/a/b.svg",
    "/badge/unknown",
    "/badge/..svg",
    "/badge/shop.example.com.svg/x",
    "/badge/x%2f..%2f..%2faccount.svg",
    "/badge/x%2F..%2F..%2Faccount.svg",
    "/badge/x%5c..%5caccount.svg",
    "/badge/shop.example.com%00.svg",
    "/badge/shop.example.com;a.svg",
    "/badge/SHOP.example.com.svg",
    "/badge/%2e%2e.svg",
    "/badge/..account.svg",
    "/s/x%2f..%2f../bridge/action-bridge.html",
    "/s/x%2f..%2f..%2faccount/bridge/action-bridge.html",
    "/s/..x/bridge/action-bridge.html",
    "/s/SHOP.example.com/bridge/action-bridge.html",
    "/s/x;y/bridge/action-bridge.html",
    "/s/shop.example.com/bridge/x%2f..%2f..%2faccount",
    "/badges/x.svg",
    "/x/badge/shop.example.com.svg",
    "/account",
    "/account/reports/x",
    "/sitemap.xml",
  ])("runs on %s", (url) => {
    expect(runs(url)).toBe(true);
  });

  // Fails if a literal dot segment after the bridge folder is skipped (doesMatch parses the URL, so the raw pattern is tested).
  it("the bridge exclusion never covers a dot segment", () => {
    const source = (config.matcher[0] as { source: string }).source;
    const pattern = new RegExp(`^${source.replace(/^\//, "/")}$`);
    for (const path of ["/s/x/bridge/..", "/s/x/bridge/../..", "/s/x/bridge/../../account", "/s/x/bridge/.hidden"]) expect(pattern.test(path), path).toBe(true);
    expect(pattern.test("/s/x/bridge/action-bridge.html")).toBe(false);
  });
});

describe("headers of published files", () => {
  // Fails if the published page loses the page CSP or may be cached, so an unpublish would not end it at once.
  it("the page and the agent files get the page CSP and no-store", () => {
    for (const path of ["/s/shop.example.com", "/s/shop.example.com/content-actions.js"]) {
      const res = proxy(new NextRequest(`http://127.0.0.1:3010${path}`));
      expect(res.headers.get("content-security-policy")).toMatch(/^default-src 'self'; script-src 'self' 'nonce-[^']+'; /);
      expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
      expect(res.headers.get("cache-control")).toBe("private, no-store");
    }
  });

  // Fails if the published bridge is not frameable, may run other scripts, or the rule covers more than one bridge file.
  it("the published bridge has the bridge policy", () => {
    const rules = staticSecurityHeaders().filter((r) => r.source.startsWith("/s/"));
    expect(rules).toEqual([{ source: "/s/:host/bridge/:file", headers: [{ key: "Content-Security-Policy", value: BRIDGE_CSP }] }]);
  });
});
