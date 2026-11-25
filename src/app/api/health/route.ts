import { handleHealth, healthDegraded, type HealthDeps } from "@/lib/api/health";
import { getServerDeps } from "@/lib/server/runtime";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  let deps: HealthDeps;
  try {
    const { store, accounts } = getServerDeps();
    deps = { store, accounts };
  } catch (e) {
    console.error("[TABLE_FALLBACK] health: store not available:", e instanceof Error ? e.message : "unknown");
    return healthDegraded();
  }
  return handleHealth(deps);
}
