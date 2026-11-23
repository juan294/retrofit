import { handleSignOut } from "@/lib/api/sign-out";
import { getServerDeps } from "@/lib/server/runtime";

export const dynamic = "force-dynamic";

export function POST(request: Request): Promise<Response> {
  return handleSignOut(request, getServerDeps());
}
