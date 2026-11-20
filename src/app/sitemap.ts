import type { MetadataRoute } from "next";
import { getConfig } from "@/lib/config";
import { OWN_PAGES } from "@/lib/site/own-site";

export const dynamic = "force-dynamic";

export default function sitemap(): MetadataRoute.Sitemap {
  const origin = getConfig().publicOrigin;
  return OWN_PAGES.map((p) => ({ url: `${origin}${p.path}` }));
}
