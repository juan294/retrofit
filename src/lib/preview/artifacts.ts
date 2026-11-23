import { readFile } from "node:fs/promises";
import path from "node:path";
import { getAnalysis, isAnalysisId, readAnalysisView } from "@/lib/analysis/record";
import { bundleFiles } from "@/lib/bundle/files";
import { writeZip } from "@/lib/bundle/zip";
import { visitorTexts } from "@/lib/analysis/texts";
import { ownsAnalysis, requesterOf } from "@/lib/analysis/owner";
import type { JobDeps } from "@/lib/crawl/jobs";
import { GenerationFailed, generateNetwork, type GeneratedPreview, type NetworkValidator } from "@/lib/generate/network";

export interface PreviewDeps extends JobDeps {
  /** Replaces the vendored validator (tests force a failure through it). */
  readonly validate?: NetworkValidator;
  /** Folder holding content-actions.js and bridge/. Defaults to public/preview-assets. */
  readonly assetsDir?: string;
}

const DEFAULT_ASSETS = path.join(process.cwd(), "public", "preview-assets");
const JSON_TYPE = "application/json";
const TYPES: Record<string, string> = { ".js": "text/javascript; charset=utf-8", ".html": "text/html; charset=utf-8", ".json": JSON_TYPE };
// One plain file name inside bridge/: no dot files, no separators, no traversal.
const BRIDGE_FILE = /^[a-z0-9][a-z0-9-]*\.(?:html|js|json)$/;
/** What the runtime's links loader reads: `doc.networks[<name>]`, here nothing (runtime/engine.js `_loadPublishedLinks`). */
const EMPTY_LINKS = { version: 1, networks: {} } as const;

function respond(status: number, body: BodyInit, contentType: string): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": contentType,
      "cache-control": "private, no-store",
      "x-robots-tag": "noindex",
      "x-content-type-options": "nosniff",
    },
  });
}

const jsonResponse = (status: number, body: unknown) => respond(status, JSON.stringify(body), JSON_TYPE);
const notFound = () => jsonResponse(404, { error: "not_found" });
const otherBrowser = () => jsonResponse(404, { error: "not_found", message: visitorTexts.otherBrowser });

type Artifact = { kind: "json"; body: unknown } | { kind: "asset"; relative: string };

/** Maps the path segments to one allowed artifact, or null. Exact names only. */
function resolveArtifact(g: GeneratedPreview, segments: readonly string[]): Artifact | null {
  if (segments.length === 1) {
    switch (segments[0]) {
      case "agent-manifest.json":
        return { kind: "json", body: g.manifest };
      case `${g.networkName}.network.json`:
        return { kind: "json", body: g.network };
      case "site-content.json":
        return { kind: "json", body: g.siteContent };
      case "links.json":
        return { kind: "json", body: EMPTY_LINKS };
      case "content-actions.js":
        return { kind: "asset", relative: "content-actions.js" };
      default:
        return null;
    }
  }
  if (segments.length === 2 && segments[0] === "bridge" && BRIDGE_FILE.test(segments[1] ?? "")) {
    return { kind: "asset", relative: `bridge/${segments[1]}` };
  }
  return null;
}

async function serveAsset(assetsDir: string, relative: string): Promise<Response> {
  const root = path.resolve(assetsDir);
  const file = path.resolve(root, relative);
  // Defense in depth: the allowlist already admits no separator or dot segment.
  if (!file.startsWith(root + path.sep)) return notFound();
  const type = TYPES[path.extname(file)];
  if (!type) return notFound();
  try {
    return respond(200, await readFile(file, "utf8"), type);
  } catch {
    return notFound();
  }
}

/**
 * GET /p/[id]/[...file]: the private preview's artifacts, served only to the
 * analysis owner: its visitor or its attached account (same 404 text for another
 * visitor or account and an unknown id).
 * Expired -> 410 with the expiry text. Not ready, or GenerationFailed -> 404 with
 * the generation text. content-actions.js and bridge/* are read from
 * public/preview-assets and returned at this URL (a rewrite, not a redirect), so
 * content-actions.js finds ./site-content.json next to its own module URL.
 */
export async function handlePreviewFile(request: Request, deps: PreviewDeps, id: string, segments: readonly string[]): Promise<Response> {
  const who = requesterOf(request);
  if ((!who.visitorToken && !who.accountToken) || !isAnalysisId(id)) return otherBrowser();
  let generated: GeneratedPreview;
  try {
    const analysis = await getAnalysis(deps.store, id);
    if (!analysis || !(await ownsAnalysis(analysis, who, deps))) return otherBrowser();
    const view = await readAnalysisView(deps, analysis);
    if (view.status === "expired") return jsonResponse(410, { error: "expired", message: view.failure?.message ?? visitorTexts.expired(new Date(analysis.expiresAt)) });
    const snapshot = view.analysis.snapshot;
    if (view.status !== "ready" || !snapshot) return jsonResponse(404, { error: "not_ready", message: visitorTexts.generationFailed });
    try {
      if (segments.length === 1 && segments[0] === "bundle.zip") {
        const { topFolder, entries } = await bundleFiles(snapshot, deps.validate);
        const response = respond(200, writeZip(entries), "application/zip");
        response.headers.set("content-disposition", `attachment; filename="${topFolder}.zip"`);
        return response;
      }
      generated = generateNetwork({ snapshot, publicOrigin: deps.config.publicOrigin }, { validate: deps.validate });
    } catch (e) {
      if (!(e instanceof GenerationFailed)) throw e;
      console.error("Preview generation failed:", e.message);
      return jsonResponse(404, { error: "generation_failed", message: visitorTexts.generationFailed });
    }
  } catch (e) {
    console.error("GET /p/[id] failed:", e instanceof Error ? e.message : String(e));
    return jsonResponse(503, { error: "unavailable", message: visitorTexts.unavailable });
  }
  const artifact = resolveArtifact(generated, segments);
  if (!artifact) return notFound();
  if (artifact.kind === "json") return jsonResponse(200, artifact.body);
  return serveAsset(deps.assetsDir ?? DEFAULT_ASSETS, artifact.relative);
}
