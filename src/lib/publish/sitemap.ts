import type { ServerDeps } from "@/lib/server/runtime";
import { publishedUrl } from "./view";

/** Most published pages sitemap.xml lists (the most recently refreshed). */
export const SITEMAP_PUBLISHED_MAX = 1000;

/** The URLs of the published pages, for sitemap.xml. None when the account data is unavailable (the adapter logs it), so the static sitemap still answers. */
export async function publishedSitemap(deps: Pick<ServerDeps, "accounts" | "config">): Promise<string[]> {
  try {
    return (await deps.accounts.listPublicHosts(SITEMAP_PUBLISHED_MAX)).map((host) => publishedUrl(deps.config.publicOrigin, host));
  } catch (e) {
    console.error("[TABLE_FALLBACK] sitemap without published pages:", e instanceof Error ? e.name : "unknown error");
    return [];
  }
}
