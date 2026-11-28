import { agentJsonFiles, asJson } from "@/lib/generate/agent-json";
import { generateNetwork, validatedHost, type NetworkValidator } from "@/lib/generate/network";
import type { Snapshot } from "@/lib/snapshot/types";
import { bundleAssets } from "./assets";
import { assistantHtml, assistantScript } from "./assistant";
import { bundleReadme, hostingFiles } from "./readme";
import type { PreparedZipData } from "./zip";

interface BundleEntry {
  path: string;
  bytes: Buffer;
  prepared?: PreparedZipData;
}

function textEntries(files: Record<string, string>): BundleEntry[] {
  return Object.entries(files).map(([path, text]) => ({ path, bytes: Buffer.from(text) }));
}

/** Files for an owner's static installation. Only site-content.json carries fetched page data. */
export async function bundleFiles(snapshot: Snapshot, validate?: NetworkValidator) {
  const generated = generateNetwork({ snapshot, target: "bundle" }, { validate });
  const { manifest, networkName } = generated;
  const host = validatedHost(snapshot.host);
  const date = snapshot.fetchedAt.slice(0, 10);
  // A colon cannot appear in a Windows filename. Leave room for "retrofit-", the date and ".zip" within 255 bytes.
  const filenameHost = host.length <= 232 ? host.replace(":", "-") : networkName;
  const topFolder = `retrofit-${filenameHost}-${date}`;
  const agentMcp = asJson(manifest.agent_mcp);
  const site: BundleEntry[] = [
    ...await bundleAssets(),
    ...textEntries({
      ...agentJsonFiles(generated),
      "agent-mcp.json": agentMcp,
      ".well-known/nsdeploy.json": asJson(manifest.linking),
      ".well-known/nsdeploy-agent.json": agentMcp,
      "assistant/index.html": assistantHtml(host, date),
      "assistant/site.js": assistantScript(host, date),
    }),
  ];
  const entries = [
    ...site.map(entry => ({ ...entry, path: `${topFolder}/site/${entry.path}` })),
    ...textEntries({
      "README.md": bundleReadme(host, date, site.map(entry => entry.path).sort()),
      ...hostingFiles(networkName),
    }).map(entry => ({ ...entry, path: `${topFolder}/${entry.path}` })),
  ];
  return { topFolder, entries };
}
