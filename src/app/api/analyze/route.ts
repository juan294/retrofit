import { handleAnalyze } from "@/lib/api/analyze";
import { getServerDeps } from "@/lib/server/runtime";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

export function POST(request: Request): Promise<Response> {
  return handleAnalyze(request, getServerDeps());
}
