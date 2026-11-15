import { handleModels } from "@/lib/inference/proxy";
import { getServerDeps } from "@/lib/server/runtime";

export const dynamic = "force-dynamic";

/** Lists only the free model. No credentials: the runtime calls /models before a send without Authorization. */
export function GET(): Response {
  return handleModels(getServerDeps());
}
