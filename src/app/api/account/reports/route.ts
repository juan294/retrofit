import { handleSaveReport } from "@/lib/api/saved-reports";
import { getServerDeps } from "@/lib/server/runtime";

export const dynamic = "force-dynamic";

export function POST(request: Request): Promise<Response> {
  return handleSaveReport(request, getServerDeps());
}
