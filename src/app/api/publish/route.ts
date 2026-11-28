import { handlePublish } from "@/lib/api/publish";
import { getServerDeps } from "@/lib/server/runtime";

export const dynamic = "force-dynamic";

export function POST(request: Request): Promise<Response> {
  return handlePublish(request, getServerDeps());
}
