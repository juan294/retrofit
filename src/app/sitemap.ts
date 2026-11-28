import type { MetadataRoute } from "next";
import { getConfig } from "@/lib/config";
import { publishedSitemap } from "@/lib/publish/sitemap";
import { getServerDeps } from "@/lib/server/runtime";
import { OWN_PAGES } from "@/lib/site/own-site";

export const dynamic = "force-dynamic";

/** Retrofit's own pages, then the published sites' pages (none when the account data is unavailable). */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const origin = getConfig().publicOrigin;
  const published = await publishedSitemap(getServerDeps());
  return [...OWN_PAGES.map((p) => `${origin}${p.path}`), ...published].map((url) => ({ url }));
}
