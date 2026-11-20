// Test-only caller networks for the local spec §6 harness (phase-4.md "Local spec §6 harness").
// Served host-routed at the root of CALLER_E2E_ORIGIN and CALLER_DENIED_ORIGIN, and only
// when fixturesEnabled. Built from Retrofit's own published files, which stay unchanged.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config";
import { CALLER_DENIED_HOST, CALLER_E2E_HOST, FIXTURE_PEER_ORIGINS, PEER_A_ORIGIN, PEER_A_VARIANTS, PEER_B_ORIGIN } from "./origins";

/**
 * The private context key that must never reach a peer. Neuro SAN and the vendored runtime
 * model private context as per-request `sly_data`, not as a network field: the runtime UI
 * sends `slyData: { backend_token: ... }` on every chat turn (runtime/ui.js:571), and a
 * remote call forwards only what the front agent's `allow.to_downstream.sly_data` lists
 * (runtime/runner.js:454-457, runtime/kernel.js:45-56). The caller networks carry no
 * `allow` rule, so the peer invocation gets `sly_data: {}`; its trace payload is
 * `redactSlyData(request.sly_data)` (runtime/engine.js:589).
 */
export const CALLER_PRIVATE_SLY_KEY = "backend_token";

interface FixtureArtifact {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: string;
}

interface Agent {
  name: string;
  tools?: string[];
  [key: string]: unknown;
}
interface NetworkConfig {
  tools: Agent[];
  link_labels?: Record<string, string>;
  [key: string]: unknown;
}
interface Manifest {
  networks: Record<string, unknown>[];
  llm_router: Record<string, unknown>;
  linking: Record<string, unknown>;
  agent_mcp: Record<string, unknown>;
  [key: string]: unknown;
}

interface CallerSpec {
  readonly network: string;
  /** Remote tools added to Retrofit's front agent, with their consent-card labels. */
  readonly peers: Readonly<Record<string, string>>;
  readonly allowedPeers: readonly string[];
}

const E2E: CallerSpec = {
  network: "retrofit_guide_e2e",
  peers: {
    [`${PEER_A_ORIGIN}/peer_demo`]: "Peer A demo",
    [`${PEER_B_ORIGIN}/peer_b_demo`]: "Peer B demo",
    ...Object.fromEntries(PEER_A_VARIANTS.map((v) => [`${PEER_A_ORIGIN}/${v}/peer_demo`, `Peer A demo (${v})`])),
  },
  allowedPeers: FIXTURE_PEER_ORIGINS,
};

/** Calls peer-a, which its closed policy does not allow. */
const DENIED: CallerSpec = {
  network: "retrofit_guide_denied",
  peers: { [`${PEER_A_ORIGIN}/peer_demo`]: "Peer A demo" },
  allowedPeers: [PEER_B_ORIGIN],
};

const CALLERS: Record<string, CallerSpec> = { [CALLER_E2E_HOST]: E2E, [CALLER_DENIED_HOST]: DENIED };

const publicFiles = new Map<string, string>();
function publicFile(name: string): string {
  let text = publicFiles.get(name);
  if (text === undefined) {
    text = readFileSync(join(process.cwd(), "public", name), "utf8");
    publicFiles.set(name, text);
  }
  return text;
}

function callerNetwork(spec: CallerSpec): NetworkConfig {
  const network = JSON.parse(publicFile("retrofit_guide.network.json")) as NetworkConfig;
  const front = network.tools[0]!;
  front.tools = [...(front.tools ?? []), ...Object.keys(spec.peers)];
  network.link_labels = { ...(network.link_labels ?? {}), ...spec.peers };
  return network;
}

function callerManifest(spec: CallerSpec, config: Pick<Config, "publicOrigin">): Manifest {
  const manifest = JSON.parse(publicFile("agent-manifest.json")) as Manifest;
  const entry = manifest.networks[0]!;
  const frontMan = entry.front_man;
  const name = spec.network;
  manifest.brand = `Retrofit assistant (${name})`;
  manifest.networks = [{ ...entry, name, hocon: `./${name}.network.json` }];
  manifest.llm_router = { ...manifest.llm_router, base_url: `${config.publicOrigin}/api/inference/v1` };
  manifest.allowed_peers = [...spec.allowedPeers];
  manifest.peer_policy = { mode: "closed", deny_origins: [], note: "Test fixture caller." };
  manifest.agent_mcp = { ...manifest.agent_mcp, network: name, front_man: frontMan };
  manifest.linking = { ...manifest.linking, exports: [{ network: name, front_man: frontMan, aliases: [name], url: name }] };
  return manifest;
}

const AGENT_FILE_HEADERS = { "access-control-allow-origin": "*", "cache-control": "no-store", "x-robots-tag": "noindex" };
const jsonArtifact = (data: unknown): FixtureArtifact => ({
  status: 200,
  headers: { ...AGENT_FILE_HEADERS, "content-type": "application/json; charset=utf-8" },
  body: `${JSON.stringify(data, null, 2)}\n`,
});

/**
 * The caller artifact for a Host header value (host:port) and pathname, or null when
 * fixtures are off, the host is not a caller host, or the path is not an artifact.
 */
export function callerArtifact(host: string, pathname: string, config: Pick<Config, "fixturesEnabled" | "publicOrigin">): FixtureArtifact | null {
  if (!config.fixturesEnabled) return null;
  const spec = CALLERS[host.toLowerCase()];
  if (!spec) return null;
  switch (pathname) {
    case "/agent-manifest.json":
      return jsonArtifact(callerManifest(spec, config));
    case `/${spec.network}.network.json`:
      return jsonArtifact(callerNetwork(spec));
    case "/links.json":
      return jsonArtifact(JSON.parse(publicFile("links.json")));
    case "/site-actions.js":
      return { status: 200, headers: { ...AGENT_FILE_HEADERS, "content-type": "text/javascript; charset=utf-8" }, body: publicFile("site-actions.js") };
    default:
      return null;
  }
}
