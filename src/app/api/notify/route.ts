import { handleNotify } from "@/lib/api/notify";
import { getServerDeps } from "@/lib/server/runtime";

export const dynamic = "force-dynamic";

export function POST(request: Request): Promise<Response> {
  return handleNotify(request, getServerDeps());
}
