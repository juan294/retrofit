import { handleCleanup } from "@/lib/api/cleanup";
import { getServerDeps } from "@/lib/server/runtime";

export const dynamic = "force-dynamic";

export function GET(request: Request): Promise<Response> {
  return handleCleanup(request, getServerDeps());
}
