import { alertToday } from "../ops/daily";
import type { ServerDeps } from "../server/runtime";
import { hasBearer } from "../analysis/visitor";
import { json } from "./json";

/** Recorded Stripe events are kept this long: Stripe redelivers for days, and a later replay changes nothing (AccountData pruneStripeEvents). */
export const STRIPE_EVENTS_KEPT_MS = 90 * 24 * 3600_000;
/** Events pruned in one run. */
const PRUNE_LIMIT = 10_000;
/** A typed address that was never confirmed is kept at the sign-in provider this long; its link works for one hour. */
export const UNCONFIRMED_KEPT_MS = 24 * 3600_000;
/** Unconfirmed users purged in one run. */
const PURGE_LIMIT = 1000;

/**
 * GET /api/cron/cleanup (Vercel Cron): `Authorization: Bearer <CRON_SECRET>`, then deletes expired store rows,
 * old recorded Stripe events, and sign-in users that were never confirmed and have no account. The steps do not
 * depend on each other; 503 with `failed` when one fails, and one alert a day.
 */
export async function handleCleanup(request: Request, deps: Pick<ServerDeps, "config" | "store" | "accounts" | "clock">): Promise<Response> {
  if (!hasBearer(request, deps.config.cronSecret)) return json(401, { error: "unauthorized" });
  const before = (ms: number) => new Date(deps.clock() - ms).toISOString();
  const { store, accounts } = deps;
  const failed: string[] = [];
  const step = async (name: string, run: () => Promise<number>): Promise<number> => {
    try {
      return await run();
    } catch (e) {
      console.error(`[TABLE_FALLBACK] cleanup failed (${name}):`, e instanceof Error ? e.name : "unknown error");
      failed.push(name);
      return 0;
    }
  };
  const [deleted, stripeEvents, unconfirmedUsers] = await Promise.all([
    step("store", async () => store.cleanup?.() ?? 0),
    step("stripe_events", () => accounts.pruneStripeEvents(before(STRIPE_EVENTS_KEPT_MS), PRUNE_LIMIT)),
    step("unconfirmed_users", () => accounts.purgeUnconfirmedUsers(before(UNCONFIRMED_KEPT_MS), PURGE_LIMIT)),
  ]);
  const counts = {
    deleted,
    ...(store.cleanup ? {} : { note: "This store drops expired entries on read." }),
    ...(stripeEvents > 0 ? { stripeEvents } : {}),
    ...(unconfirmedUsers > 0 ? { unconfirmedUsers } : {}),
  };
  if (failed.length === 0) return json(200, counts);
  await alertToday(deps, "cleanup", "The daily cleanup failed", `Failed steps: ${failed.join(", ")}. Expired data is kept until a run works.`);
  return json(503, { error: "unavailable", ...counts, failed });
}
