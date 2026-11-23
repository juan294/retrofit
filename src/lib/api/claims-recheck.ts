import { hasBearer } from "@/lib/analysis/visitor";
import { recheckDueClaims } from "@/lib/claims/recheck";
import type { ServerDeps } from "@/lib/server/runtime";
import { json } from "./json";

/**
 * GET /api/cron/claims (Vercel Cron, daily): `Authorization: Bearer <CRON_SECRET>` (401 otherwise,
 * also when CRON_SECRET is unset), then rechecks the due claims (src/lib/claims/recheck.ts) and
 * answers the counts. 503 when the due claims cannot be listed.
 */
export async function handleClaimsRecheck(request: Request, deps: Pick<ServerDeps, "config" | "accounts" | "clock" | "fetch" | "txt">): Promise<Response> {
  if (!hasBearer(request, deps.config.cronSecret)) return json(401, { error: "unauthorized" });
  try {
    return json(200, await recheckDueClaims(deps));
  } catch (e) {
    console.error("[TABLE_FALLBACK] claims recheck failed:", e instanceof Error ? e.name : "unknown error");
    return json(503, { error: "unavailable" });
  }
}
