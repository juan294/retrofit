import { execFile } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { parseHocon } from "../../tools/agentic-web/runtime/hocon.js";
import { AgentNetwork, validateNetwork } from "../../tools/agentic-web/runtime/kernel.js";
import { remoteIsInChain } from "../../tools/agentic-web/runtime/runner.js";
import { manifestAllowsPeer } from "../../tools/agentic-web/runtime/engine.js";
import { PartnerCheck } from "../../tools/agentic-web/scripts/check_partner.mjs";
import { CONFORMANCE_FIXTURES, CONFORMANCE_NETWORK, DENIED_ORIGIN, serveTopManifest, withTopNetwork } from "@/lib/peer/conformance";
import { PEER_HOST, PEER_ORIGIN, RETROFIT_ORIGIN } from "@/lib/peer/host";
import { staticSecurityHeaders } from "@/lib/security/headers";

// The organizers' own scripts are the oracle (research 2026-11-15-phase-4-entry.md §3).
const run = promisify(execFile);
const ROOT = path.resolve(__dirname, "../..");
const BUILD = path.join(ROOT, "tools/agentic-web/scripts/build_network.mjs");
const RUNTIME = path.join(ROOT, "tools/agentic-web/runtime");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");
const json = <T>(p: string) => JSON.parse(read(p)) as T;

interface Entry {
  name: string;
  front_man: string;
  hocon: string;
  sample_queries?: string[];
}
interface Manifest {
  networks: Entry[];
  allowed_peers: string[];
  peer_policy: { mode: string; deny_origins: string[] };
  actions?: unknown;
  [key: string]: unknown;
}
interface NetworkConfig {
  tools: { name: string; tools?: string[]; allow?: unknown; instructions?: string }[];
  link_labels?: Record<string, string>;
}

const validate = (text: string, name: string) => validateNetwork(new AgentNetwork(parseHocon(text), name)) as { errors: string[]; externals: string[] };
const peerManifest = () => json<Manifest>("peers/demo-harbor/public/agent-manifest.json");
const retrofitManifest = () => json<Manifest>("public/agent-manifest.json");

/** Every network published on the peer host and on Retrofit, with its served file. */
const PUBLISHED = [
  { name: "harbor_tours", file: "peers/demo-harbor/public/harbor_tours.network.json", source: "peers/demo-harbor/agent/harbor_tours.hocon" },
  { name: "harbor_loop", file: "peers/demo-harbor/public/harbor_loop.network.json", source: "peers/demo-harbor/agent/harbor_loop.hocon" },
  { name: "retrofit_guide", file: "public/retrofit_guide.network.json", source: "agent/retrofit_guide.hocon" },
  { name: "retrofit_conformance", file: "public/retrofit_conformance.network.json", source: "agent/retrofit_conformance.hocon" },
] as const;

async function build(args: string[]) {
  try {
    const r = await run(process.execPath, [BUILD, ...args, "--runtime", RUNTIME], { cwd: ROOT });
    return { code: 0, out: r.stdout + r.stderr };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? -1, out: (err.stdout ?? "") + (err.stderr ?? "") };
  }
}

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

/**
 * Runs the full build (with --manifest) for a network that is not networks[0] of its
 * published manifest: build_network.mjs checks only networks[0], so a copy of the manifest
 * with that network first goes into a scratch folder, next to a copy of the source.
 */
async function buildAsFirst(source: string, manifest: Manifest, name: string) {
  const dir = await mkdtemp(path.join(tmpdir(), "retrofit-peer-"));
  dirs.push(dir);
  const hocon = path.join(dir, `${name}.hocon`);
  await copyFile(path.join(ROOT, source), hocon);
  const top = withTopNetwork(manifest, name)!;
  const entry = top.networks[0]!;
  // The discovery blocks describe networks[0], so the scratch copy names this network there.
  const scratch = {
    ...top,
    agent_mcp: { ...(top.agent_mcp as object), network: name, front_man: entry.front_man },
    linking: { ...(top.linking as object), exports: [{ network: name, front_man: entry.front_man, aliases: [name], url: name }] },
  };
  await writeFile(path.join(dir, "agent-manifest.json"), JSON.stringify(scratch, null, 2));
  return build([hocon, "--manifest", path.join(dir, "agent-manifest.json"), "--out", path.join(dir, `${name}.network.json`)]);
}

describe("published peer and conformance networks", () => {
  for (const n of PUBLISHED) {
    // Fails if a published network would be refused by a caller's runtime.
    it(`${n.name} passes the vendored validateNetwork, from its source and from the served file`, () => {
      expect(validate(read(n.source), n.name).errors).toEqual([]);
      expect(validate(read(n.file), n.name).errors).toEqual([]);
      expect(JSON.parse(read(n.file))).toEqual(parseHocon(read(n.source)));
    });
  }

  it("harbor_invalid parses but fails validateNetwork, so the caller's runtime refuses it", () => {
    const text = read("peers/demo-harbor/public/harbor_invalid.network.json");
    expect(() => JSON.parse(text)).not.toThrow();
    const { errors } = validate(text, "harbor_invalid");
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join(" ")).toContain("missing_specialist");
  });

  it("no published network forwards private sly_data downstream", () => {
    for (const n of PUBLISHED) for (const agent of json<NetworkConfig>(n.file).tools) expect(agent.allow, `${n.name}.${agent.name}`).toBeUndefined();
  });
});

describe("build_network.mjs on the committed outputs", () => {
  // The pnpm peer:check commands.
  it("--check passes for harbor_tours with the peer manifest and its discovery files", async () => {
    const r = await build([
      "peers/demo-harbor/agent/harbor_tours.hocon",
      "--manifest",
      "peers/demo-harbor/public/agent-manifest.json",
      "--out",
      "peers/demo-harbor/public/harbor_tours.network.json",
      "--check",
    ]);
    expect(r.code, r.out).toBe(0);
  }, 30_000);

  it("--check passes for harbor_loop and retrofit_conformance (network-only builds)", async () => {
    for (const [source, out] of [
      ["peers/demo-harbor/agent/harbor_loop.hocon", "peers/demo-harbor/public/harbor_loop.network.json"],
      ["agent/retrofit_conformance.hocon", "public/retrofit_conformance.network.json"],
    ] as const) {
      const r = await build([source, "--out", out, "--check"]);
      expect(r.code, `${source}\n${r.out}`).toBe(0);
    }
  }, 30_000);

  // Fails if --check could pass on a stale output, so the test above would prove nothing.
  it("--check fails when a committed output differs", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "retrofit-peer-"));
    dirs.push(dir);
    const out = path.join(dir, "harbor_loop.network.json");
    await writeFile(out, read("peers/demo-harbor/public/harbor_loop.network.json").replace("loop_guide", "loop_guide_x"));
    const r = await build(["peers/demo-harbor/agent/harbor_loop.hocon", "--out", out, "--check"]);
    expect(r.code, r.out).not.toBe(0);
  }, 30_000);

  it("harbor_loop passes the full partner checks with the peer manifest (label, https, allowed origin)", async () => {
    const r = await buildAsFirst("peers/demo-harbor/agent/harbor_loop.hocon", peerManifest(), "harbor_loop");
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain(`Partner tools: retrofit_conformance -> ${RETROFIT_ORIGIN}/retrofit_conformance ("Retrofit conformance")`);
  }, 30_000);

  // The denied tool is the point of the fixture: its origin is not in allowed_peers.
  it("retrofit_conformance fails the full partner checks only for the demo-denied tool", async () => {
    const r = await buildAsFirst("agent/retrofit_conformance.hocon", retrofitManifest(), CONFORMANCE_NETWORK);
    expect(r.code).toBe(1);
    const errors = r.out.split("\n").filter((l) => l.startsWith("ERROR"));
    expect(errors).toEqual([
      `ERROR: conformance_guide: ${DENIED_ORIGIN}/none is not allowed. Add "${DENIED_ORIGIN}" to allowed_peers in the manifest: the runtime refuses every other origin.`,
    ]);
  }, 30_000);
});

describe("manifests", () => {
  it("the peer manifest lists the three networks under a closed policy that allows only Retrofit", () => {
    const m = peerManifest();
    expect(m.networks.map((e) => [e.name, e.hocon])).toEqual([
      ["harbor_tours", "./harbor_tours.network.json"],
      ["harbor_invalid", "./harbor_invalid.network.json"],
      ["harbor_loop", "./harbor_loop.network.json"],
    ]);
    expect(m.peer_policy).toMatchObject({ mode: "closed", deny_origins: [] });
    expect(m.allowed_peers).toEqual([RETROFIT_ORIGIN]);
    // No actions: callers load no bridge, and the network answers from its own text.
    expect(m.actions).toBeUndefined();
    expect(m.networks[0]!.sample_queries).toEqual(json<{ metadata: { sample_queries: string[] } }>("peers/demo-harbor/public/harbor_tours.network.json").metadata.sample_queries);
  });

  it("Retrofit's manifest publishes retrofit_conformance second and allows only the peer origin", () => {
    const m = retrofitManifest();
    expect(m.networks.map((e) => e.name)).toEqual(["retrofit_guide", CONFORMANCE_NETWORK]);
    expect(m.networks[1]).toMatchObject({ front_man: "conformance_guide", hocon: `./${CONFORMANCE_NETWORK}.network.json` });
    expect(m.allowed_peers).toEqual([PEER_ORIGIN]);
    expect(m.peer_policy.mode).toBe("closed");
    expect(m.networks[1]!.sample_queries).toEqual(json<{ metadata: { sample_queries: string[] } }>("public/retrofit_conformance.network.json").metadata.sample_queries);
  });

  it("Retrofit's guide calls harbor_tours with a link label", () => {
    const n = json<NetworkConfig>("public/retrofit_guide.network.json");
    expect(n.tools[0]!.tools).toEqual(["readiness_specialist", `${PEER_ORIGIN}/harbor_tours`]);
    expect(n.link_labels).toEqual({ [`${PEER_ORIGIN}/harbor_tours`]: "Harbor tours demo" });
  });

  it("retrofit_conformance calls exactly the documented fixtures, each with its label", () => {
    const n = json<NetworkConfig>("public/retrofit_conformance.network.json");
    expect(n.tools).toHaveLength(1);
    expect(n.tools[0]!.tools).toEqual(CONFORMANCE_FIXTURES.map((f) => f.url));
    expect(n.link_labels).toEqual(Object.fromEntries(CONFORMANCE_FIXTURES.map((f) => [f.url, f.label])));
    for (const f of CONFORMANCE_FIXTURES) expect(n.tools[0]!.instructions, f.tool).toMatch(new RegExp(`\\b${f.tool}\\b`));
  });

  // The runtime's own policy check (runtime/engine.js manifestAllowsPeer) against the published manifests.
  it("the policy allows the peer, refuses demo-denied, and lets harbor_loop call Retrofit", () => {
    expect(manifestAllowsPeer(PEER_ORIGIN, retrofitManifest())).toBe(true);
    expect(manifestAllowsPeer(DENIED_ORIGIN, retrofitManifest())).toBe(false);
    expect(manifestAllowsPeer(RETROFIT_ORIGIN, peerManifest())).toBe(true);
    expect(manifestAllowsPeer(DENIED_ORIGIN, peerManifest())).toBe(false);
  });

  it("index.html and harbor_tours carry the same tours", () => {
    const html = read("peers/demo-harbor/public/index.html");
    const hocon = read("peers/demo-harbor/agent/harbor_tours.hocon");
    for (const tour of ["Lighthouse walk", "Sunset sail", "Seal watch", "Pier 2"]) {
      expect(html, tour).toContain(tour);
      expect(hocon, tour).toContain(tour);
    }
  });
});

describe("cycle prevention for harbor_loop", () => {
  // The runtime drops a remote tool whose `<origin>::<name>` is already in the chain while it
  // builds the tool table (runtime/runner.js remoteIsInChain). The chain starts with
  // `<top base>::<networks[0].name>` (runtime/engine.js run), so the call back is dropped only
  // when retrofit_conformance is networks[0] of a manifest at the origin root.
  it("drops the call back when /conformance boots retrofit_conformance at the origin root", () => {
    const top = withTopNetwork(retrofitManifest(), CONFORMANCE_NETWORK)!;
    expect(top.networks[0]!.name).toBe(CONFORMANCE_NETWORK);
    const chain = [`${RETROFIT_ORIGIN}::${top.networks[0]!.name}`, `${PEER_ORIGIN}::harbor_loop`];
    const back = json<NetworkConfig>("peers/demo-harbor/public/harbor_loop.network.json").tools[0]!.tools![0]!;
    expect(back).toBe(`${RETROFIT_ORIGIN}/${CONFORMANCE_NETWORK}`);
    expect(remoteIsInChain(back, PEER_ORIGIN, chain)).toBe(true);
    // Without the reorder, networks[0] is retrofit_guide and the call back would run.
    expect(remoteIsInChain(back, PEER_ORIGIN, [`${RETROFIT_ORIGIN}::retrofit_guide`, `${PEER_ORIGIN}::harbor_loop`])).toBe(false);
  });
});

describe("withTopNetwork and serveTopManifest", () => {
  it("moves the named network first and keeps every other field", () => {
    const m = retrofitManifest();
    const top = withTopNetwork(m, CONFORMANCE_NETWORK)!;
    expect(top.networks.map((e) => e.name)).toEqual([CONFORMANCE_NETWORK, "retrofit_guide"]);
    expect({ ...top, networks: m.networks }).toEqual(m);
    expect(m.networks[0]!.name).toBe("retrofit_guide");
    expect(withTopNetwork(m, "nope")).toBeNull();
    expect(withTopNetwork({ networks: "x" } as unknown as Manifest, "x")).toBeNull();
  });

  it("answers only GET for the exact manifest URL until released, then restores fetch", async () => {
    const original = vi.fn(async () => new Response("from network"));
    const target = { fetch: original as unknown as typeof fetch };
    const url = `${RETROFIT_ORIGIN}/agent-manifest.json`;
    const release = serveTopManifest(target, url, { networks: [{ name: "a" }] });
    expect(await (await target.fetch(url)).json()).toEqual({ networks: [{ name: "a" }] });
    expect(await (await target.fetch(new URL(url))).json()).toEqual({ networks: [{ name: "a" }] });
    expect(await (await target.fetch(`${RETROFIT_ORIGIN}/p/x/agent-manifest.json`)).text()).toBe("from network");
    expect(await (await target.fetch(url, { method: "POST" })).text()).toBe("from network");
    expect(original).toHaveBeenCalledTimes(2);
    release();
    expect(target.fetch).toBe(original);
    release();
    expect(target.fetch).toBe(original);
  });

  it("does not restore over a fetch that replaced it later", () => {
    const original = (async () => new Response("")) as unknown as typeof fetch;
    const later = (async () => new Response("")) as unknown as typeof fetch;
    const target = { fetch: original };
    const release = serveTopManifest(target, `${RETROFIT_ORIGIN}/agent-manifest.json`, {});
    target.fetch = later;
    release();
    expect(target.fetch).toBe(later);
  });
});

/**
 * check_partner.mjs against the files as each host serves them: the peer host through the
 * peer route, Retrofit through public/ with the headers of next.config.ts
 * (staticSecurityHeaders). Node's fetch is replaced, so nothing leaves the machine.
 */
describe("check_partner.mjs on the served files", () => {
  let GET: typeof import("@/app/peer/[...path]/route").GET;
  beforeAll(async () => {
    process.env.SESSION_SECRET = "x".repeat(32);
    GET = (await import("@/app/peer/[...path]/route")).GET;
  });

  const rules = staticSecurityHeaders();
  const matches = (source: string, p: string) => (source.endsWith("/:path*") ? p.startsWith(source.slice(0, -"/:path*".length) + "/") || source === "/:path*" : source === p);
  const TYPES: Record<string, string> = { ".json": "application/json", ".html": "text/html", ".js": "text/javascript" };

  async function serveRetrofit(p: string): Promise<Response> {
    let body: string;
    try {
      body = await readFile(path.join(ROOT, "public", p), "utf8");
    } catch {
      return new Response("Not found", { status: 404 });
    }
    const headers = new Headers({ "content-type": TYPES[path.extname(p)] ?? "application/octet-stream" });
    for (const r of rules) if (matches(r.source, p)) for (const h of r.headers) headers.set(h.key, h.value);
    return new Response(body, { status: 200, headers });
  }

  const fakeFetch = async (input: string | URL | Request): Promise<Response> => {
    const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (u.origin === PEER_ORIGIN) {
      const segments = u.pathname.slice(1).split("/");
      return GET(new Request(`http://localhost:3010/peer${u.pathname}`, { headers: { host: PEER_HOST } }), { params: Promise.resolve({ path: segments }) });
    }
    if (u.origin === RETROFIT_ORIGIN) return serveRetrofit(u.pathname);
    throw new Error(`unexpected fetch ${u.href}`);
  };

  async function check(url: string) {
    const lines: string[] = [];
    const code = await PartnerCheck.main([url], fakeFetch, (l: string) => lines.push(l));
    return { code, out: lines.join("\n") };
  }

  for (const url of [`${PEER_ORIGIN}/harbor_tours`, `${PEER_ORIGIN}/harbor_loop`, `${RETROFIT_ORIGIN}/retrofit_guide`, `${RETROFIT_ORIGIN}/${CONFORMANCE_NETWORK}`]) {
    it(`exits 0 for ${url}`, async () => {
      const r = await check(url);
      expect(r.code, r.out).toBe(0);
    });
  }

  it("exits 1 for harbor_invalid, because the runtime's validation refuses it", async () => {
    const r = await check(`${PEER_ORIGIN}/harbor_invalid`);
    expect(r.code).toBe(1);
    expect(r.out).toContain("fails the runtime's validation");
  });

  it("the peer host serves no network that the manifest does not list", async () => {
    const r = await check(`${PEER_ORIGIN}/harbor_missing`);
    expect(r.code).toBe(1);
    expect(r.out).toContain('lists no network named "harbor_missing"');
  });
});
