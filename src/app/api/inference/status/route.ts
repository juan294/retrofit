import { handleStatus } from "@/lib/inference/proxy";
import { getServerDeps } from "@/lib/server/runtime";

export const dynamic = "force-dynamic";

/** `{available, pool, reason}` for the session cookie, with no amounts. */
export function GET(request: Request): Promise<Response> {
  return handleStatus(request, getServerDeps());
}
