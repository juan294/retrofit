import { handleConfirm } from "@/lib/api/confirm";
import { getServerDeps } from "@/lib/server/runtime";

export const dynamic = "force-dynamic";

/** The "Sign in" and "Continue" buttons of /auth/confirm (src/lib/api/confirm.ts). */
export function POST(request: Request): Promise<Response> {
  return handleConfirm(request, getServerDeps());
}
