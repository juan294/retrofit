import type { NextConfig } from "next";
import { staticSecurityHeaders } from "./src/lib/security/headers";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  typescript: { tsconfigPath: "tsconfig.build.json" },
  // The preview route reads the vendored content-actions module and bridge from disk.
  outputFileTracingIncludes: { "/p/[id]/[...file]": ["./public/preview-assets/**/*"] },
  async headers() {
    return staticSecurityHeaders();
  },
};

export default nextConfig;
