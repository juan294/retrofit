import { exactHost } from "@/lib/publish/host";
import type { ServerDeps } from "@/lib/server/runtime";
import { json } from "@/lib/api/json";
import { badgeSvg } from "./svg";

/** A browser may show a badge this long after its site stopped being public. */
export const BADGE_MAX_AGE_S = 3600;
const SUFFIX = ".svg";

/**
 * GET /badge/<host>.svg: the published host's score as an image any site may embed, cached one hour.
 * 404 (never cached) for an unknown, unpublished or lapsed host, a host in another form and any other
 * file name; 503 when the account data is unavailable. The image's own policy allows nothing, so opening
 * it on Retrofit's origin runs nothing. The request hook skips it (src/proxy.ts), so these headers stand.
 */
export async function handleBadge(deps: Pick<ServerDeps, "accounts">, file: string): Promise<Response> {
  const host = file.endsWith(SUFFIX) ? exactHost(file.slice(0, -SUFFIX.length)) : null;
  let site;
  try {
    site = host === null ? null : await deps.accounts.getPublicSite(host);
  } catch (e) {
    console.error("GET /badge failed:", e instanceof Error ? e.name : "unknown error");
    return json(503, { error: "unavailable" });
  }
  if (!site) return json(404, { error: "not_found" });
  return new Response(badgeSvg(site.score), {
    headers: {
      "content-type": "image/svg+xml",
      "cache-control": `public, max-age=${BADGE_MAX_AGE_S}`,
      "access-control-allow-origin": "*",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
    },
  });
}
