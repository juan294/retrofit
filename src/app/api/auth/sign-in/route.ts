import { handleSignIn } from "@/lib/api/sign-in";
import { getServerDeps } from "@/lib/server/runtime";

export const dynamic = "force-dynamic";

export function POST(request: Request): Promise<Response> {
  return handleSignIn(request, getServerDeps());
}
