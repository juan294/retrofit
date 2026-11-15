// Retrofit's published conformance fixtures (phase-7.md, "Production peer"). The network
// retrofit_conformance (agent/retrofit_conformance.hocon) is the second entry of
// public/agent-manifest.json and runs on the /conformance page.

import { PEER_ORIGIN } from "./host";

export const CONFORMANCE_NETWORK = "retrofit_conformance";

/** Not in any allowed_peers. The runtime refuses it before any contact, so the host needs no DNS record. */
export const DENIED_ORIGIN = "https://demo-denied.thecreativetoken.com";

export interface ConformanceFixture {
  /** The tool name the model sees (the last path segment). */
  readonly tool: string;
  readonly url: string;
  /** The consent-card label (link_labels). */
  readonly label: string;
  /** What a conforming runtime and host page do, for the /conformance page. */
  readonly expect: string;
}

/** The fixtures in the order of the front agent's tools. tests/peer/networks.test.ts checks them against the network file. */
export const CONFORMANCE_FIXTURES: readonly ConformanceFixture[] = [
  {
    tool: "harbor_tours",
    url: `${PEER_ORIGIN}/harbor_tours`,
    label: "Harbor tours demo",
    expect:
      "A working two-agent peer network with fictional tours. A consent card names the peer host first; declining sends nothing, approving runs the network in this browser with your router. No cookie or key goes to the peer.",
  },
  {
    tool: "harbor_invalid",
    url: `${PEER_ORIGIN}/harbor_invalid`,
    label: "Harbor invalid fixture",
    expect: "A network that fails the runtime's validation on purpose. The runtime refuses to run it, and this page shows the error.",
  },
  {
    tool: "harbor_loop",
    url: `${PEER_ORIGIN}/harbor_loop`,
    label: "Harbor loop fixture",
    expect:
      "Its front agent calls retrofit_conformance back. The runtime drops that call before the peer's model sees it, Retrofit's network is not fetched again, and this page shows a loop notice.",
  },
  {
    tool: "none",
    url: `${DENIED_ORIGIN}/none`,
    label: "Denied demo",
    expect: "Its origin is not in allowed_peers. After the consent card, the runtime refuses the call, and no request reaches that host.",
  },
];

interface NetworkEntry {
  readonly name?: unknown;
}

/**
 * The manifest with the named network moved to networks[0], every other field unchanged,
 * or null when the manifest does not list it. The runtime always runs networks[0] as the
 * top network, and it drops a call back only when the chain starts with
 * `<origin root>::<that name>` (research 2026-11-15-phase-4-entry.md §7).
 */
export function withTopNetwork<T extends { readonly networks: readonly NetworkEntry[] }>(manifest: T, name: string): T | null {
  if (!Array.isArray(manifest.networks)) return null;
  const entry = manifest.networks.find((n) => n?.name === name);
  if (!entry) return null;
  return { ...manifest, networks: [entry, ...manifest.networks.filter((n) => n !== entry)] };
}

type Fetch = typeof fetch;

/**
 * Makes `target.fetch` answer a GET for exactly `url` with `manifest`, and pass every other
 * request to the fetch it replaces (the page's fetch guard). The returned function restores
 * that fetch, unless something replaced it since.
 */
export function serveTopManifest(target: { fetch: Fetch }, url: string, manifest: unknown): () => void {
  const previous = target.fetch;
  const body = JSON.stringify(manifest);
  const serving: Fetch = (input, init) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (raw === url && method === "GET") return Promise.resolve(new Response(body, { status: 200, headers: { "content-type": "application/json; charset=utf-8" } }));
    return previous(input, init);
  };
  target.fetch = serving;
  return () => {
    if (target.fetch === serving) target.fetch = previous;
  };
}
