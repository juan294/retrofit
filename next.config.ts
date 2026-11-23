import type { NextConfig } from "next";
import { peerRewrites } from "./src/lib/peer/rewrites";
import { PUBLISHED_ASSETS } from "./src/lib/publish/assets";
import { staticSecurityHeaders } from "./src/lib/security/headers";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // /api/version reports the commit the build was made from (vercel deploy --build-env BUILD_COMMIT=<sha>).
  env: { BUILD_COMMIT: process.env.BUILD_COMMIT ?? "" },
  reactStrictMode: true,
  typescript: { tsconfigPath: "tsconfig.build.json" },
  // The private artifact route reads the install bundle assets from disk.
  outputFileTracingIncludes: {
    "/p/**": ["./public/preview-assets/**/*", "./public/runtime/**/*", "./tools/agentic-web/templates/assistant.css"],
    // A published site's agent files: content-actions.js, the bridge page and its runtime modules.
    "/s/**": [...PUBLISHED_ASSETS.values()].map((file) => `./public/${file}`),
    // The demo-harbor peer route reads its static site from disk.
    "/peer/[...path]": ["./peers/demo-harbor/public/**/*", "./peers/demo-harbor/public/.well-known/*"],
  },
  async headers() {
    return staticSecurityHeaders();
  },
  // The peer host serves only its own site, including paths the request hook does not see.
  async rewrites() {
    return { beforeFiles: peerRewrites(), afterFiles: [], fallback: [] };
  },
};

export default nextConfig;
