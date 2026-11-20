import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isPeerHost } from "./host";

/**
 * The page CSP of the peer's index.html: a static page with inline styles and no
 * scripts, connections, frames or forms.
 */
export const PEER_PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const PAGE = "/index.html";

/**
 * The only files the peer host serves, from peers/demo-harbor/public/: the page and the
 * agent files (JSON). Every agent file allows every origin: other sites' runtimes and
 * check_partner.mjs read them cross-origin. The HOCON sources in peers/demo-harbor/agent/
 * are never served.
 */
export const PEER_PUBLIC_FILES: readonly string[] = [
  PAGE,
  "/agent-manifest.json",
  "/harbor_tours.network.json",
  "/harbor_invalid.network.json",
  "/harbor_loop.network.json",
  "/agent-mcp.json",
  "/.well-known/nsdeploy.json",
  "/.well-known/nsdeploy-agent.json",
];

/** Folder that holds the served files; next.config.ts traces it into the peer route. */
export const PEER_PUBLIC_DIR = join("peers", "demo-harbor", "public");

export interface PeerFile {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: string;
}

const cache = new Map<string, string>();
function readPeerFile(pathname: string): string {
  let text = cache.get(pathname);
  if (text === undefined) {
    // pathname is one of PEER_PUBLIC_FILES, never visitor input, so it cannot leave the folder.
    text = readFileSync(join(process.cwd(), PEER_PUBLIC_DIR, pathname), "utf8");
    cache.set(pathname, text);
  }
  return text;
}

/**
 * The peer file for a Host header value and pathname, or null when the host is not the
 * peer host or the path is not an exact published file. The lookup is an exact match on
 * a fixed list, so no traversal, encoded segment or source file can resolve.
 */
export function peerFile(host: string, pathname: string, config: { readonly fixturesEnabled: boolean }): PeerFile | null {
  if (!isPeerHost(host, config) || !PEER_PUBLIC_FILES.includes(pathname)) return null;
  const page = pathname === PAGE;
  const headers: Record<string, string> = {
    "content-type": page ? "text/html; charset=utf-8" : "application/json; charset=utf-8",
    "cache-control": "public, max-age=300",
    "x-content-type-options": "nosniff",
  };
  if (page) headers["content-security-policy"] = PEER_PAGE_CSP;
  else headers["access-control-allow-origin"] = "*";
  return { status: 200, headers, body: readPeerFile(pathname) };
}
