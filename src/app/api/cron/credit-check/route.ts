import { handleCreditCheck } from "@/lib/ops/credit-check";
import { getServerDeps } from "@/lib/server/runtime";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

/** Vercel Cron, daily. `Authorization: Bearer <CRON_SECRET>`. */
export async function GET(request: Request): Promise<Response> {
  return handleCreditCheck(request, getServerDeps());
}
