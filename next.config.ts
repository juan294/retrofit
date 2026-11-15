import type { NextConfig } from "next";
import { staticSecurityHeaders } from "./src/lib/security/headers";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  typescript: { tsconfigPath: "tsconfig.build.json" },
  async headers() {
    return staticSecurityHeaders();
  },
};

export default nextConfig;
