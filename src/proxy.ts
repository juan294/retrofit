import { NextResponse, type NextRequest } from "next/server";
import { PEER_HOST, peerHostRewrite } from "@/lib/peer/host";
import { getConfig } from "@/lib/config";
import { pageCsp } from "@/lib/security/headers";
import { connectOrigins } from "@/lib/security/origins";
import { isCallerArtifactRequest } from "@/lib/test-fixtures/origins";

export function proxy(request: NextRequest) {
  const config = getConfig();
  // The synthetic peer demo-harbor is served from this deployment for its own host only. Its
  // route sets every header itself, so the page CSP and no-store are not added here. For the
  // production peer host, next.config.ts already rewrote every path before files; the fixtures
  // stand-in host is rewritten here (the before-files rule covers only the production host).
  const host = (request.headers.get("host") ?? "").toLowerCase();
  if (host === PEER_HOST) return NextResponse.next();
  const peerPath = peerHostRewrite(host, request.nextUrl.pathname, config);
  if (peerPath) return NextResponse.rewrite(new URL(peerPath, request.url));
  const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64");
  const csp = pageCsp(config, nonce, { dev: process.env.NODE_ENV === "development", phase: connectOrigins() });

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);

  // Fixtures mode only: the spec §6 callers are host-routed at their origin root, because the
  // runtime matches a cycle back edge only for a network at an origin root (notes, Phase 4).
  const fixtureCaller = isCallerArtifactRequest(config, host, request.nextUrl.pathname);
  const response = fixtureCaller
    ? NextResponse.rewrite(new URL(`/test-fixtures/caller${request.nextUrl.pathname}`, request.url), { request: { headers: requestHeaders } })
    : NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  // API routes set their own Cache-Control (the score contract requires exactly "no-store");
  // a header set here would win over the route's.
  if (!request.nextUrl.pathname.startsWith("/api/")) response.headers.set("Cache-Control", "private, no-store");
  return response;
}

export const config = {
  matcher: [
    {
      // Every response except static build assets, vendored files and the bridge,
      // and the badge image, which carry their own policies (next.config.ts, the badge
      // route). A published site's bridge file and a badge are one plain file name each, and
      // their host holds only what a normalized host may, so no dot segment, no encoded
      // character and no deeper path is skipped. Unknown paths, including
      // unknown /api/ paths, and not-found pages get the page CSP too. Prefetch
      // requests return RSC payloads, never documents.
      source: "/((?!_next/static/|_next/image|runtime/|preview-assets/|bridge/|p/[^/]+/bridge/|s/[a-z0-9][a-z0-9.:-]*/bridge/[a-z0-9][a-z0-9.-]*$|badge/[a-z0-9][a-z0-9.:-]*\\.svg$|favicon.ico).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
