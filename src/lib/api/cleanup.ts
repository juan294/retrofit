import type { ServerDeps } from "../server/runtime";
import { hasBearer } from "../analysis/visitor";
import { json } from "./json";

/** GET /api/cron/cleanup (Vercel Cron): `Authorization: Bearer <CRON_SECRET>`, then deletes expired store rows. */
export async function handleCleanup(request: Request, deps: Pick<ServerDeps, "config" | "store">): Promise<Response> {
  if (!hasBearer(request, deps.config.cronSecret)) return json(401, { error: "unauthorized" });
  if (!deps.store.cleanup) return json(200, { deleted: 0, note: "This store drops expired entries on read." });
  try {
    return json(200, { deleted: await deps.store.cleanup() });
  } catch (e) {
    console.error("[TABLE_FALLBACK] cleanup failed:", e instanceof Error ? e.message : String(e));
    return json(503, { error: "unavailable" });
  }
}
