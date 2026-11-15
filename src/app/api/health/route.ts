import { HEALTH_DEGRADED_MESSAGE, handleHealth } from "@/lib/api/health";
import { json } from "@/lib/api/json";
import { getStore } from "@/lib/server/runtime";
import type { Store } from "@/lib/store/types";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  let store: Store;
  try {
    store = getStore();
  } catch (e) {
    console.error("[TABLE_FALLBACK] health: store not available:", e instanceof Error ? e.message : "unknown");
    return json(503, { status: "degraded", message: HEALTH_DEGRADED_MESSAGE });
  }
  return handleHealth({ store });
}
