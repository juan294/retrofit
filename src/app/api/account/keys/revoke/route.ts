import { handleRevokeKey } from "@/lib/api/api-keys";
import { getServerDeps } from "@/lib/server/runtime";

export const dynamic = "force-dynamic";

export function POST(request: Request): Promise<Response> {
  return handleRevokeKey(request, getServerDeps());
}
