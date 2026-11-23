import path from "node:path";
import { asJson, bridgeManifest, EMPTY_LINKS } from "@/lib/generate/agent-json";
import { GenerationFailed, generateNetwork, networkNameFor, type GeneratedPreview, type NetworkValidator } from "@/lib/generate/network";
import { assetResponse, JSON_TYPE, jsonResponse, respond } from "@/lib/preview/agent-response";
import type { ServerDeps } from "@/lib/server/runtime";
import { PUBLISHED_PAGE_TEXT } from "@/lib/site/publish-texts";
import { PUBLISHED_ASSETS } from "./assets";
import { exactHost } from "./host";

export type PublishedFileDeps = Pick<ServerDeps, "accounts"> & {
  /** Replaces the vendored validator (tests force a failure through it). */
  readonly validate?: NetworkValidator;
};

// The build does not follow this path (it would trace all of public/): next.config.ts traces PUBLISHED_ASSETS.
const PUBLIC_DIR = path.join(/* turbopackIgnore: true */ process.cwd(), "public");

/** `asset`: a file of Retrofit's own code under public/. `fixed`: JSON that needs no site data. `generated`: JSON from the snapshot. */
type PublishedFile =
  | { readonly kind: "asset"; readonly file: string }
  | { readonly kind: "fixed"; readonly body: unknown }
  | { readonly kind: "generated"; readonly body: (g: GeneratedPreview) => unknown };

/** Maps the path segments to one published file of the host, or null. Exact names only. */
function resolvePublished(host: string, segments: readonly string[]): PublishedFile | null {
  // A segment with an encoded slash names no file: it would answer a file at another path than its own.
  if (segments.some((s) => s.includes("/"))) return null;
  const name = segments.join("/");
  const networkName = networkNameFor(host);
  switch (name) {
    case "agent-manifest.json":
      return { kind: "generated", body: (g) => g.manifest };
    case `${networkName}.network.json`:
      return { kind: "generated", body: (g) => g.network };
    case "site-content.json":
      return { kind: "generated", body: (g) => g.siteContent };
    case "links.json":
      return { kind: "fixed", body: EMPTY_LINKS };
    case "bridge/agent-manifest.json":
      return { kind: "fixed", body: bridgeManifest(networkName) };
    default: {
      const file = PUBLISHED_ASSETS.get(name);
      return file === undefined ? null : { kind: "asset", file };
    }
  }
}

const error = (status: number, code: string, message: string) => jsonResponse(status, { error: code, message });
const notFound = () => error(404, "not_found", PUBLISHED_PAGE_TEXT.filesNotFound);

/** An agent JSON file, with the install bundle's bytes: any site may read it, so other agent sites can call the published network. */
function agentJson(body: unknown): Response {
  const response = respond(200, asJson(body), JSON_TYPE);
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
  const file = host === null ? null : resolvePublished(host, segments);
  if (host === null || file === null) return notFound();
  try {
    if (file.kind === "generated") {
      const site = await deps.accounts.getPublicSnapshot(host);
      return site ? agentJson(file.body(generateNetwork({ snapshot: site.snapshot, target: "bundle" }, { validate: deps.validate }))) : notFound();
    }
    if (!(await deps.accounts.getPublicSite(host))) return notFound();
    if (file.kind === "fixed") return agentJson(file.body);
    return (await assetResponse(PUBLIC_DIR, file.file)) ?? notFound();
  } catch (e) {
    if (e instanceof GenerationFailed) {
      console.error("Published agent generation failed:", e.message);
      return notFound();
    }
    console.error("GET /s/[host] file failed:", e instanceof Error ? e.name : "unknown error");
    return error(503, "unavailable", PUBLISHED_PAGE_TEXT.unavailable);
  }
}
