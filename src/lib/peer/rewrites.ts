import { PEER_HOST, PEER_ROUTE } from "./host";

/**
 * Rewrites applied before Next.js serves any file (public files and `_next` assets included):
 * every request whose Host is the production peer host goes to the peer route, which serves
 * only the peer's own files. The request hook (src/proxy.ts) does the same for the paths it
 * matches and for the fixtures stand-in host; this rule also covers the paths it excludes.
 */
export function peerRewrites() {
  return [
    { source: "/", has: [{ type: "host" as const, value: PEER_HOST }], destination: `${PEER_ROUTE}/index.html` },
    // Rules apply in sequence: skip paths the first rule already rewrote, so nothing is rewritten twice.
    { source: "/:path((?!peer/).+)", has: [{ type: "host" as const, value: PEER_HOST }], destination: `${PEER_ROUTE}/:path` },
  ];
}
