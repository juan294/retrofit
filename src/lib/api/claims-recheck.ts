import { hasBearer } from "@/lib/analysis/visitor";
import { recheckDueClaims } from "@/lib/claims/recheck";
import { alertToday } from "@/lib/ops/daily";
import type { ServerDeps } from "@/lib/server/runtime";
import { json } from "./json";

const TITLE = "The daily claim recheck failed";

/**
 * GET /api/cron/claims (Vercel Cron, daily): `Authorization: Bearer <CRON_SECRET>` (401 otherwise,
 * also when CRON_SECRET is unset), then rechecks the due claims (src/lib/claims/recheck.ts) and
 * answers the counts. 503 when the due claims cannot be listed. Both that and checks that could not be
 * recorded open one alert a day.
 */
export async function handleClaimsRecheck(request: Request, deps: Pick<ServerDeps, "config" | "accounts" | "clock" | "fetch" | "txt" | "store">): Promise<Response> {
  if (!hasBearer(request, deps.config.cronSecret)) return json(401, { error: "unauthorized" });
  try {
    const summary = await recheckDueClaims(deps);
    if (summary.errors > 0) await alertToday(deps, "claims-recheck", TITLE, `${summary.errors} checks could not be recorded. Lost claims can stay public until a run works.`);
    return json(200, summary);
  } catch (e) {
    console.error("[TABLE_FALLBACK] claims recheck failed:", e instanceof Error ? e.name : "unknown error");
    await alertToday(deps, "claims-recheck", TITLE, "The due claims could not be listed. Lost claims can stay public until a run works.");
    return json(503, { error: "unavailable" });
  }
}
