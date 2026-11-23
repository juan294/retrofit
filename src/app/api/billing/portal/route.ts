import { handlePortal } from "@/lib/api/billing";
import { getServerDeps } from "@/lib/server/runtime";

export const dynamic = "force-dynamic";

export function POST(request: Request): Promise<Response> {
  return handlePortal(request, getServerDeps());
}
