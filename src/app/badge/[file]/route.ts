import { handleBadge } from "@/lib/badge/handler";
import { getServerDeps } from "@/lib/server/runtime";

export const dynamic = "force-dynamic";

/** GET /badge/<host>.svg (src/lib/badge/handler.ts). */
export async function GET(_request: Request, { params }: { params: Promise<{ file: string }> }): Promise<Response> {
  return handleBadge(getServerDeps(), (await params).file);
}
