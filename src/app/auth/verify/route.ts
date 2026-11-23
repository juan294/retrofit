import { handleConfirm } from "@/lib/api/confirm";
import { getServerDeps } from "@/lib/server/runtime";

export const dynamic = "force-dynamic";

/** The "Sign in" button of /auth/confirm (src/lib/api/confirm.ts). Under /auth so the retrofit_signin cookie (Path=/auth) is sent. */
export function POST(request: Request): Promise<Response> {
  return handleConfirm(request, getServerDeps());
}
