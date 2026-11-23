import type { ServerDeps } from "../server/runtime";
import { hasBearer } from "../analysis/visitor";
import { json } from "./json";

/** Recorded Stripe events are kept this long: Stripe redelivers for days, and a later replay changes nothing (AccountData pruneStripeEvents). */
export const STRIPE_EVENTS_KEPT_MS = 90 * 24 * 3600_000;
/** Events pruned in one run. */
const PRUNE_LIMIT = 10_000;

/** GET /api/cron/cleanup (Vercel Cron): `Authorization: Bearer <CRON_SECRET>`, then deletes expired store rows and old recorded Stripe events. */
export async function handleCleanup(request: Request, deps: Pick<ServerDeps, "config" | "store" | "accounts" | "clock">): Promise<Response> {
  if (!hasBearer(request, deps.config.cronSecret)) return json(401, { error: "unauthorized" });
  try {
    const stripeEvents = await deps.accounts.pruneStripeEvents(new Date(deps.clock() - STRIPE_EVENTS_KEPT_MS).toISOString(), PRUNE_LIMIT);
    const pruned = stripeEvents > 0 ? { stripeEvents } : {};
    if (!deps.store.cleanup) return json(200, { deleted: 0, note: "This store drops expired entries on read.", ...pruned });
    return json(200, { deleted: await deps.store.cleanup(), ...pruned });
  } catch (e) {
    console.error("[TABLE_FALLBACK] cleanup failed:", e instanceof Error ? e.message : String(e));
    return json(503, { error: "unavailable" });
  }
}
