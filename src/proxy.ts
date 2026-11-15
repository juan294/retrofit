import { NextResponse, type NextRequest } from "next/server";
import { getConfig } from "@/lib/config";
import { pageCsp } from "@/lib/security/headers";
import { connectOrigins } from "@/lib/security/origins";

export function proxy(request: NextRequest) {
  const config = getConfig();
  const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64");
  const csp = pageCsp(config, nonce, { dev: process.env.NODE_ENV === "development", phase: connectOrigins(config) });

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
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
      // which carry their own policies (next.config.ts). Unknown paths, including
      // unknown /api/ paths, and not-found pages get the page CSP too. Prefetch
      // requests return RSC payloads, never documents.
      source: "/((?!_next/static/|_next/image|runtime/|preview-assets/|bridge/|p/[^/]+/bridge/|favicon.ico).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
