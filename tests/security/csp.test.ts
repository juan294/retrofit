import { describe, expect, it } from "vitest";
import { loadConfig } from "@/lib/config";
import { buildConnectSrc, pageCsp, staticSecurityHeaders } from "@/lib/security/headers";
import { connectOrigins } from "@/lib/security/origins";
import { routerOrigins } from "@/lib/keys/providers";

const secret = "s".repeat(32);
const prod = loadConfig({ VERCEL: "1", SESSION_SECRET: secret, PUBLIC_ORIGIN: "https://retrofit.example" });
const fixtures = loadConfig({ RETROFIT_TEST_FIXTURES: "1", SESSION_SECRET: secret });

function directive(csp: string, name: string): string[] {
  const part = csp.split(";").map((p) => p.trim()).find((p) => p.startsWith(`${name} `) || p === name);
  return part ? part.split(/\s+/).slice(1) : [];
}

describe("page CSP", () => {
  // The same composition the request hook uses (src/proxy.ts).
  const csp = pageCsp(prod, "abc123", { phase: connectOrigins() });

  // Fails if a host source or strict-dynamic is added to script-src.
  it("allows only self and the nonce in script-src", () => {
    expect(directive(csp, "script-src")).toEqual(["'self'", "'nonce-abc123'"]);
    expect(csp).not.toContain("strict-dynamic");
    expect(csp).not.toContain("unsafe-eval");
  });

  it("keeps the fixed directives", () => {
    expect(directive(csp, "default-src")).toEqual(["'self'"]);
    expect(directive(csp, "style-src")).toEqual(["'self'", "'unsafe-inline'"]);
    expect(directive(csp, "img-src")).toEqual(["'self'", "data:"]);
    expect(directive(csp, "frame-ancestors")).toEqual(["'none'"]);
    expect(directive(csp, "object-src")).toEqual(["'none'"]);
    expect(directive(csp, "base-uri")).toEqual(["'self'"]);
    expect(directive(csp, "form-action")).toEqual(["'self'"]);
    expect(directive(csp, "frame-src")).toEqual(["'self'"]);
  });

  // Fails if a fixture origin leaks into the production policy.
  it("has no fixture origin in production", () => {
    expect(csp).not.toMatch(/fixture\.test|127\.0\.0\.1|localhost/);
    // Phase 4: the provider routers of the key panel, and nothing else.
    expect(directive(csp, "connect-src")).toEqual(["'self'", ...routerOrigins()]);
  });

  it("adds only the exact fixture origins in fixtures mode", () => {
    const extra = ["http://peer-a.fixture.test:3011"];
    const c = buildConnectSrc(fixtures, { fixtureOrigins: extra });
    expect(c).toEqual(["'self'", "http://peer-a.fixture.test:3011"]);
    expect(buildConnectSrc(prod, { fixtureOrigins: extra })).toEqual(["'self'"]);
  });

  it("adds phase origins once, deduplicated", () => {
    expect(buildConnectSrc(prod, { origins: ["https://a.example", "https://a.example"] })).toEqual(["'self'", "https://a.example"]);
  });

  it("refuses a connect-src entry that is not an exact origin", () => {
    expect(() => buildConnectSrc(prod, { origins: ["https://*.example"] })).toThrow();
    expect(() => buildConnectSrc(prod, { origins: ["https://a.example/path"] })).toThrow();
  });

  it("adds unsafe-eval only in development", () => {
    expect(directive(pageCsp(prod, "n", { dev: true }), "script-src")).toContain("'unsafe-eval'");
  });
});

describe("static headers", () => {
  const rules = staticSecurityHeaders();
  const find = (source: string) => rules.find((r) => r.source === source)?.headers ?? [];
  const value = (source: string, key: string) => find(source).find((h) => h.key === key)?.value;

  it("sends the base headers on every response", () => {
    expect(value("/:path*", "X-Content-Type-Options")).toBe("nosniff");
    expect(value("/:path*", "Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(value("/:path*", "Permissions-Policy")).toBe("camera=(), microphone=(), geolocation=()");
  });

  it("locks the sandbox worker down", () => {
    expect(value("/runtime/sandbox-worker.js", "Content-Security-Policy")).toBe(
      "default-src 'none'; script-src blob:; connect-src 'none'; worker-src 'none'",
    );
  });

  // Fails if the bridge loses its own frameable policy.
  it("lets the bridge be framed with self scripts only", () => {
    for (const s of ["/bridge/:path*", "/p/:id/bridge/:path*"]) {
      expect(value(s, "Content-Security-Policy")).toBe("script-src 'self'; frame-ancestors *");
    }
  });

  // check_partner.mjs refuses a bridge page that sends X-Frame-Options.
  it("never sends X-Frame-Options", () => {
    for (const r of rules) expect(r.headers.map((h) => h.key.toLowerCase())).not.toContain("x-frame-options");
  });

  // Other sites' runtimes and check_partner.mjs read Retrofit's public agent files from
  // their own origin. Fails if one of them loses its CORS header.
  it("lets every origin read Retrofit's public agent files", () => {
    const published = [
      "/agent-manifest.json",
      "/retrofit_guide.network.json",
      "/links.json",
      "/agent-mcp.json",
      "/.well-known/nsdeploy.json",
      "/.well-known/nsdeploy-agent.json",
    ];
    for (const s of published) expect(value(s, "Access-Control-Allow-Origin"), s).toBe("*");
    // No other rule opens CORS, in particular not the private previews under /p/.
    const open = rules.filter((r) => r.headers.some((h) => h.key === "Access-Control-Allow-Origin")).map((r) => r.source);
    expect(open.sort()).toEqual([...published].sort());
  });
});
