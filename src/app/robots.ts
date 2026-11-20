import type { MetadataRoute } from "next";
import { getConfig } from "@/lib/config";

export const dynamic = "force-dynamic";

/** Every agent may read the site; the sitemap is declared so agents find the public pages. */
export default function robots(): MetadataRoute.Robots {
  return { rules: [{ userAgent: "*", allow: "/" }], sitemap: `${getConfig().publicOrigin}/sitemap.xml` };
}
