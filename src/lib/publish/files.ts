import path from "node:path";
import { agentJsonFiles, bridgeManifestJson, linksJson } from "@/lib/bundle/files";
import { GenerationFailed, generateNetwork, networkNameFor, type NetworkValidator } from "@/lib/generate/network";
import { assetResponse, JSON_TYPE, PREVIEW_ASSETS, respond } from "@/lib/preview/artifacts";
import type { ServerDeps } from "@/lib/server/runtime";
import type { Snapshot } from "@/lib/snapshot/types";
import { PUBLISHED_PAGE_TEXT } from "@/lib/site/publish-texts";
import { exactHost } from "./host";

export type PublishedFileDeps = Pick<ServerDeps, "accounts"> & {
  /** Replaces the vendored validator (tests force a failure through it). */
  readonly validate?: NetworkValidator;
};

/** The modules the bridge page loads from ../runtime/ (a test follows their imports). No other runtime file is served here. */
export const BRIDGE_RUNTIME_FILES = ["action-bridge.js", "action-transport.js", "actions.js", "discovered-actions.js", "form-actions.js", "web-crypto.js"] as const;

const RUNTIME_DIR = path.join(process.cwd(), "public", "runtime");

/** Files of Retrofit's own code, the same for every host: the folder and the path inside it. */
const ASSETS: ReadonlyMap<string, readonly [dir: string, relative: string]> = new Map([
  ["content-actions.js", [PREVIEW_ASSETS, "content-actions.js"]],
  ["bridge/action-bridge.html", [PREVIEW_ASSETS, "bridge/action-bridge.html"]],
  ...BRIDGE_RUNTIME_FILES.map((f): [string, [string, string]] => [`runtime/${f}`, [RUNTIME_DIR, f]]),
]);

const errorResponse = (status: number, error: string, message: string) => respond(status, JSON.stringify({ error, message }), JSON_TYPE);
const notFound = () => errorResponse(404, "not_found", PUBLISHED_PAGE_TEXT.filesNotFound);

/** An agent JSON file: any site may read it, so other agent sites can call the published network. */
function agentJson(body: string): Response {
  const response = respond(200, body, JSON_TYPE);
  response.headers.set("access-control-allow-origin", "*");
  return response;
}

/**
 * GET /s/[host]/[...file]: a published site's agent files, for any visitor, with no cookie read. The
 * JSON files are the install bundle's (`target: "bundle"`: the visitor's own key, no Retrofit inference);
 * the scripts and the bridge page are Retrofit's own files, served at this URL so that content-actions.js
 * finds ./site-content.json beside it. The same 404 for an unknown, unpublished or paused host, a host in
 * another form and any other path; 503 when the account data is unavailable. Nothing is cached, so the
 * files end with the publication. Only a file that holds site data loads the snapshot.
 */
export async function handlePublishedFile(deps: PublishedFileDeps, rawHost: string, segments: readonly string[]): Promise<Response> {
  const host = exactHost(rawHost);
  // A segment with an encoded slash names no file: it would answer a file at another path than its own.
  if (host === null || segments.some((s) => s.includes("/"))) return notFound();
  const name = segments.join("/");
  const networkName = networkNameFor(host);
  const asset = ASSETS.get(name);
  const fixed = name === "links.json" ? linksJson : name === "bridge/agent-manifest.json" ? () => bridgeManifestJson(networkName) : null;
  const generated = name === "agent-manifest.json" || name === "site-content.json" || name === `${networkName}.network.json`;
  if (!asset && !fixed && !generated) return notFound();
  try {
    if (!generated) {
      if (!(await deps.accounts.getPublicSite(host))) return notFound();
      return fixed ? agentJson(fixed()) : ((await assetResponse(asset![0], asset![1])) ?? notFound());
    }
    const site = await deps.accounts.getPublicSnapshot(host);
    if (!site) return notFound();
    const files = agentJsonFiles(generateNetwork({ snapshot: site.snapshot as unknown as Snapshot, target: "bundle" }, { validate: deps.validate }));
    const body = files[name];
    return body === undefined ? notFound() : agentJson(body);
  } catch (e) {
    if (e instanceof GenerationFailed) {
      console.error("Published agent generation failed:", e.message);
      return notFound();
    }
    console.error("GET /s/[host] file failed:", e instanceof Error ? e.name : "unknown error");
    return errorResponse(503, "unavailable", PUBLISHED_PAGE_TEXT.unavailable);
  }
}
