import { randomUUID } from "node:crypto";
import { visitorTexts } from "@/lib/analysis/texts";
import { StoreUnavailable } from "@/lib/store/supabase";
import type { Store } from "@/lib/store/types";
import { json } from "./json";

/** Visitor text for the stuck state "Store unavailable in production" (parent plan). */
export const HEALTH_DEGRADED_MESSAGE = visitorTexts.unavailable;

const PROBE_TTL_S = 60;

/** The 503 answer for a store that cannot be reached or read back. */
export const healthDegraded = (): Response => json(503, { status: "degraded", message: HEALTH_DEGRADED_MESSAGE });

export interface HealthDeps {
  readonly store: Store;
}

/**
 * GET /api/health: writes a `health:<random>` row with a 60 s TTL and reads it
 * back, so the check proves data access, not only connectivity. `ok` with 200,
 * or `degraded` with 503 and the visitor text. The store logs its own failures
 * as [TABLE_FALLBACK]; a row that does not read back is logged here.
 */
export async function handleHealth(deps: HealthDeps): Promise<Response> {
  const key = `health:${randomUUID()}`;
  const probe = randomUUID();
  try {
    await deps.store.set(key, probe, PROBE_TTL_S);
    const readBack = await deps.store.get(key);
    // Delete the probe row at once, so repeated unauthenticated checks cannot grow the table.
    await deps.store.delete(key);
    if (readBack === probe) return json(200, { status: "ok" });
    console.error("[TABLE_FALLBACK] health probe row did not read back");
  } catch (e) {
    if (!(e instanceof StoreUnavailable)) {
      console.error("[TABLE_FALLBACK] health store check failed:", e instanceof Error ? e.name : "unknown");
    }
  }
  return healthDegraded();
}
