import type { MetadataRoute } from "next";
import { getConfig } from "@/lib/config";

export const dynamic = "force-dynamic";

/** Every agent may read the public site; private pages are excluded and the sitemap is declared. */
export default function robots(): MetadataRoute.Robots {
  return { rules: [{ userAgent: "*", allow: "/", disallow: ["/r/", "/p/", "/judges"] }], sitemap: `${getConfig().publicOrigin}/sitemap.xml` };
}
