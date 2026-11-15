import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseHocon } from "../../tools/agentic-web/runtime/hocon.js";
import { AgentNetwork, allowedDownstreamSly, filterSlyData, validateNetwork } from "../../tools/agentic-web/runtime/kernel.js";
import { CALLER_PRIVATE_SLY_KEY, callerArtifact } from "@/lib/test-fixtures/caller";
import {
  CALLER_DENIED_HOST,
  CALLER_DENIED_ORIGIN,
  CALLER_E2E_HOST,
  CALLER_E2E_ORIGIN,
  CALLER_HOSTS,
  FIXTURE_PEER_ORIGINS,
  PEER_A_ORIGIN,
  PEER_B_ORIGIN,
} from "@/lib/test-fixtures/origins";
import { PEER_A_VARIANTS, peerSites } from "../peer-fixture";

// `connection()` needs a Next request scope; the page's own config check is what this file tests.
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), connection: async () => {} }));

const PUBLIC_ORIGIN = "http://127.0.0.1:3010";
const on = { fixturesEnabled: true, publicOrigin: PUBLIC_ORIGIN };
const off = { fixturesEnabled: false, publicOrigin: PUBLIC_ORIGIN };
const ARTIFACTS = ["/agent-manifest.json", "/retrofit_guide_e2e.network.json", "/retrofit_guide_denied.network.json", "/links.json", "/site-actions.js"];

const publicFile = (name: string) => readFileSync(join(process.cwd(), "public", name), "utf8");
const retrofitManifest = JSON.parse(publicFile("agent-manifest.json")) as Manifest;
const retrofitNetwork = JSON.parse(publicFile("retrofit_guide.network.json")) as NetworkConfig;

interface Manifest {
  networks: { name: string; front_man: string; hocon: string }[];
  llm_router: { base_url: string; byok_router: string; model?: string };
  allowed_peers: string[];
  peer_policy: { mode: string };
  linking: { exports: { network: string; url: string; aliases: string[] }[] };
  agent_mcp: { network: string; front_man: string };
  actions: unknown;
}
interface Agent {
  name: string;
  instructions?: string;
  tools?: string[];
  allow?: unknown;
}
interface NetworkConfig {
  tools: Agent[];
  link_labels?: Record<string, string>;
}

function body<T>(host: string, path: string): T {
  const r = callerArtifact(host, path, on);
  expect(r, `${host}${path}`).not.toBeNull();
  expect(r!.status).toBe(200);
  return JSON.parse(r!.body) as T;
}
const remoteTools = (n: NetworkConfig) => n.tools.flatMap((a) => (a.tools ?? []).filter((t) => /^https?:\/\//.test(t)));

const EXPECTED_E2E_TOOLS = [
  "http://peer-a.fixture.test:3011/peer_demo",
  "http://peer-b.fixture.test:3011/peer_b_demo",
  ...[...PEER_A_VARIANTS].map((v) => `http://peer-a.fixture.test:3011/${v}/peer_demo`),
];

describe("fixture routes with fixturesEnabled false", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.RETROFIT_TEST_FIXTURES = "";
    process.env.SESSION_SECRET = "x".repeat(32);
  });

  it("callerArtifact serves nothing on any caller host", () => {
    for (const host of CALLER_HOSTS) for (const path of ARTIFACTS) expect(callerArtifact(host, path, off), `${host}${path}`).toBeNull();
  });

  it("the caller route answers 404 for every artifact", async () => {
    const { GET } = await import("@/app/test-fixtures/caller/[...path]/route");
    for (const host of CALLER_HOSTS) {
      for (const path of ARTIFACTS) {
        const res = await GET(new Request(`http://${host}/test-fixtures/caller${path}`, { headers: { host } }), {
          params: Promise.resolve({ path: path.slice(1).split("/") }),
        });
        expect(res.status, `${host}${path}`).toBe(404);
        expect(await res.text()).not.toContain("retrofit_guide");
      }
    }
  });

  it("the CSP violation page calls notFound", async () => {
    const { default: Page } = await import("@/app/test-fixtures/csp-violation/page");
    await expect(Page()).rejects.toMatchObject({ digest: "NEXT_HTTP_ERROR_FALLBACK;404" });
  });
});

describe("fixture routes with fixturesEnabled true", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.RETROFIT_TEST_FIXTURES = "1";
    process.env.SESSION_SECRET = "x".repeat(32);
  });
  afterEach(() => {
    process.env.RETROFIT_TEST_FIXTURES = "";
  });

  it("the CSP violation page renders", async () => {
    const { default: Page } = await import("@/app/test-fixtures/csp-violation/page");
    await expect(Page()).resolves.toBeTruthy();
  });

  it("the caller route serves the artifact for the Host header and 404 for other hosts and paths", async () => {
    const { GET } = await import("@/app/test-fixtures/caller/[...path]/route");
    const call = (host: string, path: string[]) =>
      GET(new Request(`http://localhost:3010/test-fixtures/caller/${path.join("/")}`, { headers: { host } }), { params: Promise.resolve({ path }) });
    const res = await call(CALLER_E2E_HOST, ["agent-manifest.json"]);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(((await res.json()) as Manifest).networks[0]!.name).toBe("retrofit_guide_e2e");
    expect((await call("127.0.0.1:3010", ["agent-manifest.json"])).status).toBe(404);
    expect((await call(CALLER_E2E_HOST, ["nope.json"])).status).toBe(404);
    expect((await call(CALLER_E2E_HOST, ["bridge", "agent-manifest.json"])).status).toBe(404);
  });

  it("serves nothing for hosts that are not caller hosts, or for unknown paths", () => {
    expect(callerArtifact("127.0.0.1:3010", "/agent-manifest.json", on)).toBeNull();
    expect(callerArtifact("caller-e2e.fixture.test:3011", "/agent-manifest.json", on)).toBeNull();
    expect(callerArtifact(CALLER_E2E_HOST, "/retrofit_guide.network.json", on)).toBeNull();
    expect(callerArtifact(CALLER_E2E_HOST, "/retrofit_guide_denied.network.json", on)).toBeNull();
    expect(callerArtifact(CALLER_DENIED_HOST, "/retrofit_guide_e2e.network.json", on)).toBeNull();
    expect(callerArtifact(CALLER_E2E_HOST.toUpperCase(), "/agent-manifest.json", on)).not.toBeNull();
  });

  it("the e2e manifest publishes retrofit_guide_e2e with both peers allowed under a closed policy", () => {
    const m = body<Manifest>(CALLER_E2E_HOST, "/agent-manifest.json");
    expect(m.networks).toHaveLength(1);
    expect(m.networks[0]).toMatchObject({ name: "retrofit_guide_e2e", front_man: "retrofit_guide", hocon: "./retrofit_guide_e2e.network.json" });
    expect(m.allowed_peers).toEqual(FIXTURE_PEER_ORIGINS);
    expect(m.peer_policy.mode).toBe("closed");
    expect(m.llm_router).toEqual({ ...retrofitManifest.llm_router, base_url: `${PUBLIC_ORIGIN}/api/inference/v1` });
    expect(m.linking.exports).toEqual([{ network: "retrofit_guide_e2e", front_man: "retrofit_guide", aliases: ["retrofit_guide_e2e"], url: "retrofit_guide_e2e" }]);
    expect(m.agent_mcp).toMatchObject({ network: "retrofit_guide_e2e", front_man: "retrofit_guide" });
    expect(m.actions).toEqual(retrofitManifest.actions);
  });

  it("the e2e network is Retrofit's network plus one remote tool per peer and variant, each labelled", () => {
    const n = body<NetworkConfig>(CALLER_E2E_HOST, "/retrofit_guide_e2e.network.json");
    expect(validateNetwork(new AgentNetwork(n, "retrofit_guide_e2e")).errors).toEqual([]);
    expect(n.tools.map((a) => a.name)).toEqual(retrofitNetwork.tools.map((a) => a.name));
    const front = n.tools[0]!;
    expect(front.instructions).toBe(retrofitNetwork.tools[0]!.instructions);
    expect(front.tools).toEqual([...retrofitNetwork.tools[0]!.tools!, ...EXPECTED_E2E_TOOLS]);
    expect(n.tools[1]).toEqual(retrofitNetwork.tools[1]);
    expect(Object.keys(n.link_labels ?? {}).sort()).toEqual([...EXPECTED_E2E_TOOLS].sort());
    expect(new Set(Object.values(n.link_labels ?? {})).size).toBe(EXPECTED_E2E_TOOLS.length);
    // Retrofit's published files are untouched.
    expect(retrofitNetwork.tools[0]!.tools).toEqual(["readiness_specialist"]);
  });

  it("every e2e remote tool lands on a peer fixture base that serves a manifest", () => {
    const sites = peerSites({ routerOrigin: "http://127.0.0.1:4555" });
    const allowed = body<Manifest>(CALLER_E2E_HOST, "/agent-manifest.json").allowed_peers;
    for (const tool of remoteTools(body<NetworkConfig>(CALLER_E2E_HOST, "/retrofit_guide_e2e.network.json"))) {
      const u = new URL(tool);
      expect(allowed, tool).toContain(u.origin);
      const segments = u.pathname.split("/");
      const name = segments.pop()!;
      const manifest = sites[u.hostname]?.[`${segments.join("/")}/agent-manifest.json`];
      expect(manifest, tool).toBeDefined();
      if (manifest!.status === 302) continue; // the redirect-manifest variant
      expect((JSON.parse(manifest!.body!) as Manifest).networks[0]!.name, tool).toBe(name);
    }
  });

  it("the denied variant calls peer-a, which is not in its allowed_peers", () => {
    const m = body<Manifest>(CALLER_DENIED_HOST, "/agent-manifest.json");
    expect(m.networks[0]).toMatchObject({ name: "retrofit_guide_denied", hocon: "./retrofit_guide_denied.network.json" });
    expect(m.peer_policy.mode).toBe("closed");
    expect(m.allowed_peers).toEqual([PEER_B_ORIGIN]);
    const n = body<NetworkConfig>(CALLER_DENIED_HOST, "/retrofit_guide_denied.network.json");
    expect(validateNetwork(new AgentNetwork(n, "retrofit_guide_denied")).errors).toEqual([]);
    expect(remoteTools(n)).toEqual([`${PEER_A_ORIGIN}/peer_demo`]);
    expect(m.allowed_peers).not.toContain(PEER_A_ORIGIN);
    expect(n.link_labels?.[`${PEER_A_ORIGIN}/peer_demo`]).toBeTruthy();
  });

  it("has no allow rule, so the runtime's per-turn private sly_data key never goes downstream", () => {
    // ui.js sends this key on every chat turn; runner.js filters it with the front agent's allow rule.
    expect(publicFile("runtime/ui.js")).toContain(`slyData: { ${CALLER_PRIVATE_SLY_KEY}: "demo-customer-token-123" }`);
    expect(publicFile("runtime/runner.js")).toContain(
      "const downstreamSly = filterSlyData(ctx.slyData, allowedDownstreamSly(ctx.network.getAgentSpec(ctx.frontMan)) || []);",
    );
    for (const [host, file] of [
      [CALLER_E2E_HOST, "/retrofit_guide_e2e.network.json"],
      [CALLER_DENIED_HOST, "/retrofit_guide_denied.network.json"],
    ] as const) {
      const network = new AgentNetwork(body<NetworkConfig>(host, file), "caller");
      for (const agent of body<NetworkConfig>(host, file).tools) expect(agent.allow, agent.name).toBeUndefined();
      const front = network.getAgentSpec(network.findFrontMan());
      expect(filterSlyData({ [CALLER_PRIVATE_SLY_KEY]: "secret" }, allowedDownstreamSly(front) || [])).toEqual({});
    }
  });

  it("serves links.json and Retrofit's site-actions.js unchanged, with agent-file headers", () => {
    for (const host of CALLER_HOSTS) {
      expect(body(host, "/links.json")).toEqual(JSON.parse(publicFile("links.json")));
      const js = callerArtifact(host, "/site-actions.js", on)!;
      expect(js.status).toBe(200);
      expect(js.body).toBe(publicFile("site-actions.js"));
      expect(js.headers["content-type"]).toBe("text/javascript; charset=utf-8");
      for (const path of ["/agent-manifest.json", "/links.json", "/site-actions.js"]) {
        const r = callerArtifact(host, path, on)!;
        expect(r.headers["access-control-allow-origin"], path).toBe("*");
        expect(r.headers["cache-control"], path).toBe("no-store");
      }
    }
  });

  it("names the caller origins at the root of port 3010", () => {
    expect(CALLER_E2E_ORIGIN).toBe("http://caller-e2e.fixture.test:3010");
    expect(CALLER_DENIED_ORIGIN).toBe("http://caller-denied.fixture.test:3010");
    expect(CALLER_HOSTS).toEqual([CALLER_E2E_HOST, CALLER_DENIED_HOST]);
  });
});
