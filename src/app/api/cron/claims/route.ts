import { handleClaimsRecheck } from "@/lib/api/claims-recheck";
import { getServerDeps } from "@/lib/server/runtime";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

/** Vercel Cron, daily. `Authorization: Bearer <CRON_SECRET>`. */
export function GET(request: Request): Promise<Response> {
  return handleClaimsRecheck(request, getServerDeps());
}
