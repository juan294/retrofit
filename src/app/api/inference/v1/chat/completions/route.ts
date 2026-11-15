import { handleChat } from "@/lib/inference/proxy";
import { getServerDeps } from "@/lib/server/runtime";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

/** Retrofit's free path: `Authorization: Bearer retrofit-free` and the session cookie; one buffered SSE body. */
export function POST(request: Request): Promise<Response> {
  return handleChat(request, getServerDeps());
}
