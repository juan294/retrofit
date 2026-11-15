import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isPeerHost } from "./host";

/**
 * The page CSP of the peer's index.html: a static page with inline styles and no
 * scripts, connections, frames or forms.
 */
export const PEER_PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const JSON_TYPE = "application/json; charset=utf-8";

/**
 * The only files the peer host serves, from peers/demo-harbor/public/. Every agent file
 * allows every origin: other sites' runtimes and check_partner.mjs read them cross-origin.
 * The HOCON sources in peers/demo-harbor/agent/ are never served.
 */
const FILES: Readonly<Record<string, { readonly type: string; readonly page: boolean }>> = {
  "/index.html": { type: "text/html; charset=utf-8", page: true },
  "/agent-manifest.json": { type: JSON_TYPE, page: false },
  "/harbor_tours.network.json": { type: JSON_TYPE, page: false },
  "/harbor_invalid.network.json": { type: JSON_TYPE, page: false },
  "/harbor_loop.network.json": { type: JSON_TYPE, page: false },
  "/agent-mcp.json": { type: JSON_TYPE, page: false },
  "/.well-known/nsdeploy.json": { type: JSON_TYPE, page: false },
  "/.well-known/nsdeploy-agent.json": { type: JSON_TYPE, page: false },
};

export const PEER_PUBLIC_FILES: readonly string[] = Object.keys(FILES);

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
    // pathname is a key of FILES, never visitor input, so it cannot leave the folder.
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
  if (!isPeerHost(host, config) || !Object.hasOwn(FILES, pathname)) return null;
  const file = FILES[pathname]!;
  const headers: Record<string, string> = {
    "content-type": file.type,
    "cache-control": "public, max-age=300",
    "x-content-type-options": "nosniff",
  };
  if (file.page) headers["content-security-policy"] = PEER_PAGE_CSP;
  else headers["access-control-allow-origin"] = "*";
  return { status: 200, headers, body: readPeerFile(pathname) };
}
