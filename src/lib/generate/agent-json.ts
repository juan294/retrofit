// The agent's JSON files as the organizers' build writes them, shared by the install bundle, the private
// preview and the published page.

import type { GeneratedPreview } from "./network";

/** Two-space JSON with a final newline: the bytes the organizers' build writes. */
export const asJson = (value: unknown) => JSON.stringify(value, null, 2) + "\n";

/** No published links: what the runtime's links loader reads, `doc.networks[<name>]` (runtime/engine.js `_loadPublishedLinks`). */
export const EMPTY_LINKS = { version: 1, networks: {} } as const;

/** The bridge's own manifest: the network's name and no action, module, page or catalog, so the bridge shares nothing. */
export const bridgeManifest = (networkName: string) => ({ networks: [{ name: networkName }], actions: { version: 1 } });

/** The agent's JSON files by path. */
export function agentJsonFiles({ network, manifest, networkName, siteContent }: GeneratedPreview): Record<string, string> {
  return {
    "agent-manifest.json": asJson(manifest),
    [networkName + ".network.json"]: asJson(network),
    "site-content.json": asJson(siteContent),
    "links.json": asJson(EMPTY_LINKS),
    "bridge/agent-manifest.json": asJson(bridgeManifest(networkName)),
  };
}
