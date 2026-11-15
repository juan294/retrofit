import type { ServerDeps } from "../server/runtime";
import { sameHash } from "../analysis/visitor";
import { json } from "./json";

/** A store that can delete expired rows in one call (the Supabase adapter). The memory store drops them on read. */
interface CleanableStore {
  cleanup(): Promise<number>;
}

const canClean = (store: unknown): store is CleanableStore => typeof (store as Partial<CleanableStore>)?.cleanup === "function";

/** GET /api/cron/cleanup (Vercel Cron): `Authorization: Bearer <CRON_SECRET>`, then deletes expired store rows. */
export async function handleCleanup(request: Request, deps: Pick<ServerDeps, "config" | "store">): Promise<Response> {
  const secret = deps.config.free.cronSecret;
  const auth = request.headers.get("authorization") ?? "";
  if (!secret || !sameHash(auth, `Bearer ${secret}`)) return json(401, { error: "unauthorized" });
  if (!canClean(deps.store)) return json(200, { deleted: 0, note: "This store drops expired entries on read." });
  try {
    return json(200, { deleted: await deps.store.cleanup() });
  } catch (e) {
    console.error("[TABLE_FALLBACK] cleanup failed:", e instanceof Error ? e.message : String(e));
    return json(503, { error: "unavailable" });
  }
}
