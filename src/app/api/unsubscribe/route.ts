import { handleUnsubscribePost } from "@/lib/api/unsubscribe";
import { getServerDeps } from "@/lib/server/runtime";

export const dynamic = "force-dynamic";

export function POST(request: Request): Promise<Response> {
  return handleUnsubscribePost(request, getServerDeps());
}
