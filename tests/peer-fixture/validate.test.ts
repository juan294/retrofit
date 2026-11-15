import { readFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseHocon } from "../../tools/agentic-web/runtime/hocon.js";
import { AgentNetwork, validateNetwork } from "../../tools/agentic-web/runtime/kernel.js";
import { CALLER_E2E_ORIGIN, FIXTURE_PEER_ORIGINS, PEER_A_ORIGIN, PEER_B_ORIGIN, THIRD_ORIGIN } from "@/lib/test-fixtures/origins";
import { BRIDGE_PROTOCOL, PEER_A_VARIANTS, peerSites, thirdSites } from "./index";
import type { FixtureResponse, FixtureSite } from "../fixtures/sites";
import { serveSites } from "../helpers/sites";

const ROUTER_ORIGIN = "http://127.0.0.1:4555";
const CALLER_ROUTER_HOST = "127.0.0.1:3010";

interface Manifest {
  networks: { name: string; front_man: string; hocon: string }[];
  llm_router: { base_url: string; byok_router: string };
  allowed_peers: string[];
  peer_policy: { mode: string };
  actions?: unknown;
}
interface NetworkConfig {
  tools: { name: string; tools?: string[]; allow?: unknown }[];
  link_labels?: Record<string, string>;
}

const sites = () => ({ ...peerSites({ routerOrigin: ROUTER_ORIGIN }), ...thirdSites() });
const originOfHost: Record<string, string> = {
  "peer-a.fixture.test": PEER_A_ORIGIN,
  "peer-b.fixture.test": PEER_B_ORIGIN,
  "third.fixture.test": THIRD_ORIGIN,
};

/** The served response at an absolute fixture URL (following one 302), or undefined. */
function at(url: string, follow = true): FixtureResponse | undefined {
  const u = new URL(url);
  const host = Object.entries(originOfHost).find(([, o]) => o === u.origin)?.[0];
  const r = host ? (sites() as Record<string, FixtureSite>)[host]?.[u.pathname] : undefined;
  return follow && r?.status === 302 ? at(r.headers!.location!, false) : r;
}
const json = <T>(r: FixtureResponse | undefined): T => JSON.parse(r?.body ?? "null") as T;

function validate(text: string, name: string) {
  return validateNetwork(new AgentNetwork(parseHocon(text), name)) as { errors: string[]; externals: string[] };
}

/** Every (base, manifest) served: peer-a root, each peer-a variant, peer-b and the third-origin copies. */
function manifests(): { base: string; manifest: Manifest; response: FixtureResponse }[] {
  const out: { base: string; manifest: Manifest; response: FixtureResponse }[] = [];
  for (const [host, site] of Object.entries(sites() as Record<string, FixtureSite>)) {
    for (const [path, r] of Object.entries(site)) {
      if (!path.endsWith("/agent-manifest.json") || r.status === 302) continue;
      out.push({ base: `${originOfHost[host]}${path.replace(/\/agent-manifest\.json$/, "")}`, manifest: json<Manifest>(r), response: r });
    }
  }
  return out;
}

describe("peer fixture sites", () => {
  it("serves the expected hosts with the documented origins", () => {
    expect(Object.keys(peerSites({ routerOrigin: ROUTER_ORIGIN })).sort()).toEqual(["peer-a.fixture.test", "peer-b.fixture.test"]);
    expect(Object.keys(thirdSites())).toEqual(["third.fixture.test"]);
    expect(FIXTURE_PEER_ORIGINS).toEqual(["http://peer-a.fixture.test:3011", "http://peer-b.fixture.test:3011"]);
    expect(FIXTURE_PEER_ORIGINS).not.toContain(THIRD_ORIGIN);
  });

  it("every fixture network passes the vendored validateNetwork except /invalid/", () => {
    let checked = 0;
    for (const { base, manifest } of manifests()) {
      const entry = manifest.networks[0]!;
      const hoconUrl = /^https?:\/\//.test(entry.hocon) ? entry.hocon : `${base}/${entry.hocon.replace(/^\.\//, "")}`;
      if (hoconUrl.startsWith(ROUTER_ORIGIN)) continue; // served by the mock router, never by these fixtures
      const network = at(hoconUrl);
      expect(network, `network for ${base}`).toBeDefined();
      const result = validate(network!.body!, entry.name);
      if (base === `${PEER_A_ORIGIN}/invalid`) {
        expect(result.errors).toEqual(["Agent 'peer_guide' references missing tool 'missing_specialist'."]);
      } else {
        expect(result.errors, base).toEqual([]);
        expect(new AgentNetwork(parseHocon(network!.body!), entry.name).findFrontMan()).toBe(entry.front_man);
      }
      checked++;
    }
    // peer-a root; hocon-third, hocon-peer-b, network-redirect (after its 302), loop, invalid; peer-b; third's copy.
    expect(checked).toBe(8);
  });

  it("serves every network file the manifests and redirects name, including the hocon-peer-b and third targets", () => {
    for (const path of ["/hocon-third/peer_demo.network.json", "/network-redirect/peer_demo.network.json", "/redirect-manifest/peer_demo.network.json"]) {
      const r = at(`${THIRD_ORIGIN}${path}`);
      expect(validate(r!.body!, "peer_demo").errors, path).toEqual([]);
    }
    expect(validate(at(`${PEER_B_ORIGIN}/hocon-peer-b/peer_demo.network.json`)!.body!, "peer_demo").errors).toEqual([]);
  });

  it("names a peer router that is not the caller's and has no actions, so no bridge is framed", () => {
    for (const { base, manifest } of manifests()) {
      expect(new URL(manifest.llm_router.base_url).host, base).not.toBe(CALLER_ROUTER_HOST);
      expect(manifest.llm_router.base_url).not.toContain(ROUTER_ORIGIN);
      expect(manifest.llm_router.byok_router).not.toBe("https://api.otari.ai/api/v1");
      expect(manifest.actions, base).toBeUndefined();
      expect(manifest.peer_policy.mode).toBe("closed");
    }
  });

  it("allows any origin to read every agent file", () => {
    for (const [host, site] of Object.entries(sites() as Record<string, FixtureSite>)) {
      for (const [path, r] of Object.entries(site)) {
        if (path.endsWith(".json")) expect(r.headers?.["access-control-allow-origin"], `${host}${path}`).toBe("*");
      }
    }
  });

  it("publishes each variant at its own sub-base with the network named peer_demo", () => {
    expect([...PEER_A_VARIANTS].sort()).toEqual(
      ["hocon-peer-b", "hocon-router", "hocon-third", "invalid", "loop", "network-redirect", "redirect-manifest"].sort(),
    );
    const a = peerSites({ routerOrigin: ROUTER_ORIGIN })["peer-a.fixture.test"]!;
    for (const v of PEER_A_VARIANTS) {
      const r = a[`/${v}/agent-manifest.json`]!;
      if (v === "redirect-manifest") continue;
      expect(json<Manifest>(r).networks[0]!.name, v).toBe("peer_demo");
    }
    expect(json<Manifest>(a["/agent-manifest.json"]).networks[0]).toMatchObject({ name: "peer_demo", hocon: "./peer_demo.network.json" });
    const b = peerSites({ routerOrigin: ROUTER_ORIGIN })["peer-b.fixture.test"]!;
    expect(json<Manifest>(b["/agent-manifest.json"]).networks[0]).toMatchObject({ name: "peer_b_demo", hocon: "./peer_b_demo.network.json" });
  });

  it("points each absolute hocon at the named origin", () => {
    const a = peerSites({ routerOrigin: ROUTER_ORIGIN })["peer-a.fixture.test"]!;
    const hocon = (v: string) => json<Manifest>(a[`/${v}/agent-manifest.json`]).networks[0]!.hocon;
    expect(hocon("hocon-third")).toBe(`${THIRD_ORIGIN}/hocon-third/peer_demo.network.json`);
    expect(hocon("hocon-peer-b")).toBe(`${PEER_B_ORIGIN}/hocon-peer-b/peer_demo.network.json`);
    expect(hocon("hocon-router")).toBe(`${ROUTER_ORIGIN}/hocon-router/peer_demo.network.json`);
    expect(peerSites({ routerOrigin: "http://127.0.0.1:4999/" })["peer-a.fixture.test"]!["/hocon-router/agent-manifest.json"]!.body).toContain(
      "http://127.0.0.1:4999/hocon-router/peer_demo.network.json",
    );
  });

  it("redirects the manifest and the network fetch with 302 to the same path on the third origin", () => {
    const a = peerSites({ routerOrigin: ROUTER_ORIGIN })["peer-a.fixture.test"]!;
    expect(a["/redirect-manifest/agent-manifest.json"]).toMatchObject({
      status: 302,
      headers: { location: `${THIRD_ORIGIN}/redirect-manifest/agent-manifest.json` },
    });
    expect(json<Manifest>(a["/network-redirect/agent-manifest.json"]).networks[0]!.hocon).toBe("./peer_demo.network.json");
    expect(a["/network-redirect/peer_demo.network.json"]).toMatchObject({
      status: 302,
      headers: { location: `${THIRD_ORIGIN}/network-redirect/peer_demo.network.json` },
    });
    expect(json<Manifest>(at(`${THIRD_ORIGIN}/redirect-manifest/agent-manifest.json`)).networks[0]!.name).toBe("peer_demo");
  });

  it("makes the /loop/ peer call back to the caller network at the caller's origin root", () => {
    const a = peerSites({ routerOrigin: ROUTER_ORIGIN })["peer-a.fixture.test"]!;
    const manifest = json<Manifest>(a["/loop/agent-manifest.json"]);
    expect(manifest.allowed_peers).toEqual([CALLER_E2E_ORIGIN]);
    const back = `${CALLER_E2E_ORIGIN}/retrofit_guide_e2e`;
    const text = a["/loop/peer_demo.network.json"]!.body!;
    const config = parseHocon(text) as NetworkConfig;
    const front = new AgentNetwork(config, "peer_demo").findFrontMan();
    expect(config.tools.find((t) => t.name === front)!.tools).toContain(back);
    expect(config.link_labels?.[back]).toBeTruthy();
    expect(validate(text, "peer_demo").externals).toEqual([back]);
  });

  it("gives peer agents no allow rule, so nothing from the caller's sly_data is accepted back upstream", () => {
    for (const { base, manifest } of manifests()) {
      const r = at(/^https?:/.test(manifest.networks[0]!.hocon) ? manifest.networks[0]!.hocon : `${base}/${manifest.networks[0]!.hocon.slice(2)}`);
      if (!r) continue;
      for (const agent of (parseHocon(r.body!) as NetworkConfig).tools) expect(agent.allow, `${base} ${agent.name}`).toBeUndefined();
    }
  });
});

describe("bridge host page", () => {
  const transport = readFileSync(join(process.cwd(), "public/runtime/action-transport.js"), "utf8");
  const page = peerSites({ routerOrigin: ROUTER_ORIGIN })["peer-a.fixture.test"]!["/bridge-host.html"]!;

  it("uses the vendored protocol name and message types", () => {
    expect(transport).toContain(`const protocol = "${BRIDGE_PROTOCOL}";`);
    expect(page.headers?.["content-type"]).toMatch(/^text\/html/);
    expect(page.body).toContain(JSON.stringify(BRIDGE_PROTOCOL));
    expect(page.body).toContain('type: "connect"');
    expect(page.body).toContain('type: "catalog"');
    expect(transport).toContain('peer.postMessage({ protocol, type: "connect" }, origin, [channel.port2]);');
    expect(transport).toContain('request.type === "catalog"');
  });

  it("frames the Retrofit bridge sandboxed like the runtime, and writes the outcome to #result", () => {
    expect(page.body).toContain(JSON.stringify("http://127.0.0.1:3010/bridge/action-bridge.html"));
    expect(transport).toContain('this.frame.sandbox = "allow-scripts allow-same-origin";');
    expect(page.body).toContain('frame.sandbox = "allow-scripts allow-same-origin"');
    expect(page.body).toContain('<pre id="result">');
  });

  it("takes another bridge URL", () => {
    const other = peerSites({ routerOrigin: ROUTER_ORIGIN, bridgeUrl: "http://127.0.0.1:3999/bridge/action-bridge.html" });
    expect(other["peer-a.fixture.test"]!["/bridge-host.html"]!.body).toContain(JSON.stringify("http://127.0.0.1:3999/bridge/action-bridge.html"));
  });
});

describe("served through the fixture server", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  /** GET on the loopback server with a Host header, without following redirects. */
  function get(port: number, host: string, path: string) {
    return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((resolve, reject) => {
      request({ host: "127.0.0.1", port, path, headers: { host: `${host}:${port}` } }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      })
        .on("error", reject)
        .end();
    });
  }

  it("answers the peer manifest with CORS and the redirect without following it", async () => {
    const server = await serveSites(() => peerSites({ routerOrigin: ROUTER_ORIGIN }));
    close = () => server.close();
    const manifest = await get(server.port, "peer-a.fixture.test", "/agent-manifest.json");
    expect(manifest.status).toBe(200);
    expect(manifest.headers["access-control-allow-origin"]).toBe("*");
    expect((JSON.parse(manifest.body) as Manifest).networks[0]!.name).toBe("peer_demo");
    const redirect = await get(server.port, "peer-a.fixture.test", "/redirect-manifest/agent-manifest.json");
    expect(redirect.status).toBe(302);
    expect(redirect.headers.location).toBe(`${THIRD_ORIGIN}/redirect-manifest/agent-manifest.json`);
    const peerB = await get(server.port, "peer-b.fixture.test", "/peer_b_demo.network.json");
    expect(validate(peerB.body, "peer_b_demo").errors).toEqual([]);
  });
});
