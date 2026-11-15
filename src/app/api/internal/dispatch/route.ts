import { handleDispatch } from "@/lib/api/dispatch";
import { getServerDeps } from "@/lib/server/runtime";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return handleDispatch(request, getServerDeps());
}
