import type { NextConfig } from "next";
import { peerRewrites } from "./src/lib/peer/rewrites";
import { staticSecurityHeaders } from "./src/lib/security/headers";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // /api/version reports the commit the build was made from (vercel deploy --build-env BUILD_COMMIT=<sha>).
  env: { BUILD_COMMIT: process.env.BUILD_COMMIT ?? "" },
  reactStrictMode: true,
  typescript: { tsconfigPath: "tsconfig.build.json" },
  // The preview route reads the vendored content-actions module and bridge from disk.
  outputFileTracingIncludes: {
    "/p/[id]/[...file]": ["./public/preview-assets/**/*"],
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
