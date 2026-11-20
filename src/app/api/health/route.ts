import { handleHealth, healthDegraded } from "@/lib/api/health";
import { getStore } from "@/lib/server/runtime";
import type { Store } from "@/lib/store/types";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  let store: Store;
  try {
    store = getStore();
  } catch (e) {
    console.error("[TABLE_FALLBACK] health: store not available:", e instanceof Error ? e.message : "unknown");
    return healthDegraded();
  }
  return handleHealth({ store });
}
