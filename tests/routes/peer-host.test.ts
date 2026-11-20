import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PEER_FIXTURE_HOST, PEER_HOST, peerHostRewrite } from "@/lib/peer/host";
import { PEER_PUBLIC_FILES, peerFile } from "@/lib/peer/files";

const on = { fixturesEnabled: true };
const off = { fixturesEnabled: false };
const MAIN_HOSTS = ["retrofit.thecreativetoken.com", "127.0.0.1:3010", "localhost:3010"];
const AGENT_FILES = [
  "/agent-manifest.json",
  "/harbor_tours.network.json",
  "/harbor_invalid.network.json",
  "/harbor_loop.network.json",
  "/agent-mcp.json",
  "/.well-known/nsdeploy.json",
  "/.well-known/nsdeploy-agent.json",
];
const onDisk = (path: string) => readFileSync(join(process.cwd(), "peers/demo-harbor/public", path), "utf8");

type Route = typeof import("@/app/peer/[...path]/route");
async function route(fixtures: boolean): Promise<Route["GET"]> {
  vi.resetModules();
  process.env.RETROFIT_TEST_FIXTURES = fixtures ? "1" : "";
  process.env.SESSION_SECRET = "x".repeat(32);
  return (await import("@/app/peer/[...path]/route")).GET;
}
/** A request as the route sees it after the request hook rewrote it: the Host header is the original one. */
const get = (GET: Route["GET"], host: string, segments: string[]) =>
  GET(new Request(`http://localhost:3010/peer/${segments.join("/")}`, { headers: { host } }), { params: Promise.resolve({ path: segments }) });

describe("peerHostRewrite", () => {
  it("rewrites every path on the peer host to the peer route, and / to index.html", () => {
    expect(peerHostRewrite(PEER_HOST, "/agent-manifest.json", off)).toBe("/peer/agent-manifest.json");
    expect(peerHostRewrite(PEER_HOST, "/harbor_tours.network.json", off)).toBe("/peer/harbor_tours.network.json");
    expect(peerHostRewrite(PEER_HOST, "/", off)).toBe("/peer/index.html");
    // Unknown paths still go to the peer route, which answers 404: the peer host never serves Retrofit's pages.
    expect(peerHostRewrite(PEER_HOST, "/api/health", off)).toBe("/peer/api/health");
    expect(peerHostRewrite(PEER_HOST.toUpperCase(), "/agent-manifest.json", off)).toBe("/peer/agent-manifest.json");
  });

  // Fails if the main host could reach the peer files through the request hook.
  it("never rewrites on the main host", () => {
    for (const host of MAIN_HOSTS) {
      for (const path of ["/", "/agent-manifest.json", "/peer/agent-manifest.json", "/peer/index.html"]) {
        expect(peerHostRewrite(host, path, on), `${host}${path}`).toBeNull();
      }
    }
  });

  it("serves the loopback fixture host only in fixtures mode, and only on its exact port", () => {
    expect(peerHostRewrite(PEER_FIXTURE_HOST, "/agent-manifest.json", off)).toBeNull();
    expect(peerHostRewrite(PEER_FIXTURE_HOST, "/agent-manifest.json", on)).toBe("/peer/agent-manifest.json");
    expect(peerHostRewrite("demo-harbor.fixture.test:3011", "/agent-manifest.json", on)).toBeNull();
    expect(peerHostRewrite(`${PEER_HOST}:8443`, "/agent-manifest.json", on)).toBeNull();
    expect(peerHostRewrite(`evil.${PEER_HOST}`, "/agent-manifest.json", on)).toBeNull();
  });
});

describe("peer route with fixturesEnabled false", () => {
  let GET: Route["GET"];
  beforeEach(async () => {
    GET = await route(false);
  });

  // Peer paths 404 on the main host.
  it("answers 404 on the main host for every peer file", async () => {
    for (const host of [...MAIN_HOSTS, "", PEER_FIXTURE_HOST]) {
      for (const path of ["/index.html", ...AGENT_FILES]) {
        const res = await get(GET, host, path.slice(1).split("/"));
        expect(res.status, `${host}${path}`).toBe(404);
        expect(res.headers.get("access-control-allow-origin"), `${host}${path}`).toBeNull();
        expect(await res.text()).not.toContain("harbor");
      }
    }
  });

  it("serves every public agent file on the peer host with CORS for every origin", async () => {
    for (const path of AGENT_FILES) {
      const res = await get(GET, PEER_HOST, path.slice(1).split("/"));
      expect(res.status, path).toBe(200);
      expect(res.headers.get("access-control-allow-origin"), path).toBe("*");
      expect(res.headers.get("content-type"), path).toBe("application/json; charset=utf-8");
      expect(res.headers.get("x-content-type-options"), path).toBe("nosniff");
      expect(await res.text(), path).toBe(onDisk(path));
    }
  });

  it("serves index.html with its own page CSP: no scripts, no framing, no connections", async () => {
    const res = await get(GET, PEER_HOST, ["index.html"]);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toMatch(/script-src|nonce-|unsafe-eval/);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    const html = await res.text();
    expect(html).toBe(onDisk("index.html"));
    expect(html).not.toMatch(/<script/i);
  });

  // Fails if a path outside the allowlist, or a source file next to it, could be read.
  it("refuses traversal, source files and unknown paths", async () => {
    const attempts = [
      ["..", "..", "package.json"],
      ["..", "agent", "harbor_tours.hocon"],
      ["%2e%2e", "package.json"],
      ["..%2fpackage.json"],
      [".well-known", "..", "agent-manifest.json"],
      ["agent", "harbor_tours.hocon"],
      ["harbor_tours.hocon"],
      ["AGENT-MANIFEST.JSON"],
      ["agent-manifest.json", ""],
      ["links.json"],
      ["api", "health"],
      ["index.html", "x"],
    ];
    for (const segments of attempts) {
      const res = await get(GET, PEER_HOST, segments);
      expect(res.status, segments.join("/")).toBe(404);
      expect(res.headers.get("cache-control"), segments.join("/")).toBe("no-store");
    }
    expect(peerFile(PEER_HOST, "/../package.json", off)).toBeNull();
  });

  it("lists exactly the published files, all present on disk", () => {
    expect([...PEER_PUBLIC_FILES].sort()).toEqual(["/index.html", ...AGENT_FILES].sort());
    for (const path of PEER_PUBLIC_FILES) expect(onDisk(path).length, path).toBeGreaterThan(0);
  });
});

describe("peer route with fixturesEnabled true", () => {
  let GET: Route["GET"];
  beforeEach(async () => {
    GET = await route(true);
  });
  afterEach(() => {
    process.env.RETROFIT_TEST_FIXTURES = "";
  });

  it("serves the same files on the loopback fixture host and the peer host, and nothing on the main host", async () => {
    for (const host of [PEER_FIXTURE_HOST, PEER_HOST]) {
      const res = await get(GET, host, ["agent-manifest.json"]);
      expect(res.status, host).toBe(200);
      expect(await res.text()).toBe(onDisk("agent-manifest.json"));
    }
    for (const host of MAIN_HOSTS) expect((await get(GET, host, ["agent-manifest.json"])).status, host).toBe(404);
  });
});

describe("peer host rewrites before files", () => {
  // Fails if the peer host could reach Retrofit's static files (runtime, bridge, _next) that the request hook skips.
  it("sends every path on the production peer host to the peer route", async () => {
    const { peerRewrites } = await import("@/lib/peer/rewrites");
    const rules = peerRewrites();
    expect(rules).toHaveLength(2);
    for (const r of rules) {
      expect(r.has).toEqual([{ type: "host", value: "demo-harbor.thecreativetoken.com" }]);
      expect(r.destination.startsWith("/peer/")).toBe(true);
    }
    expect(rules.find((r) => r.source === "/:path((?!peer/).+)")?.destination).toBe("/peer/:path");
  });
});
