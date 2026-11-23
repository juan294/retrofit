import { handleConfirm } from "@/lib/api/confirm";
import { getServerDeps } from "@/lib/server/runtime";

export const dynamic = "force-dynamic";

/** The link in the sign-in email (src/lib/api/confirm.ts). */
export function GET(request: Request): Promise<Response> {
  return handleConfirm(request, getServerDeps());
}
