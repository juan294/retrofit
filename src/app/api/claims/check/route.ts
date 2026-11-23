import { handleCheckClaim } from "@/lib/api/claims";
import { getServerDeps } from "@/lib/server/runtime";

export const dynamic = "force-dynamic";

export function POST(request: Request): Promise<Response> {
  return handleCheckClaim(request, getServerDeps());
}
