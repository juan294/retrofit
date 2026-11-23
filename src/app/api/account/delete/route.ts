import { handleAccountDelete } from "@/lib/api/account-delete";
import { getServerDeps } from "@/lib/server/runtime";

export const dynamic = "force-dynamic";

export function POST(request: Request): Promise<Response> {
  return handleAccountDelete(request, getServerDeps());
}
