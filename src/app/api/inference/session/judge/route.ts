import { handleJudgeUpgrade } from "@/lib/inference/session";
import { getServerDeps } from "@/lib/server/runtime";

export const dynamic = "force-dynamic";

export function POST(request: Request): Promise<Response> {
  return handleJudgeUpgrade(request, getServerDeps());
}
