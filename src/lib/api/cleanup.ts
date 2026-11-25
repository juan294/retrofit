import { alertToday } from "../ops/daily";
import type { ServerDeps } from "../server/runtime";
import { hasBearer } from "../analysis/visitor";
import { json } from "./json";

/** Recorded Stripe events are kept this long: Stripe redelivers for days, and a later replay changes nothing (AccountData pruneStripeEvents). */
export const STRIPE_EVENTS_KEPT_MS = 90 * 24 * 3600_000;
/** Events pruned in one run. */
const PRUNE_LIMIT = 10_000;
/** A typed address without an account is kept at the sign-in provider at least this long; its link works for one hour. */
export const NO_ACCOUNT_KEPT_MS = 24 * 3600_000;
/** Users purged in one run: more than the provider's email limit (300 an hour) can create in a day. */
const PURGE_LIMIT = 10_000;
/** Users purged in one statement: each deletion cascades through the sign-in tables, and the database limits a statement's time. */
const PURGE_BATCH = 500;
/** No batch starts after this: the platform ends the run at 60 s (vercel.json), and a batch takes 10 s at most. */
const PURGE_MS = 40_000;

/**
 * GET /api/cron/cleanup (Vercel Cron): `Authorization: Bearer <CRON_SECRET>`, then deletes expired store rows,
 * old recorded Stripe events, and sign-in users that have no account. The steps do not
 * depend on each other; 503 with `failed` when one fails, and one alert a day.
 */
export async function handleCleanup(request: Request, deps: Pick<ServerDeps, "config" | "store" | "accounts" | "clock">): Promise<Response> {
  if (!hasBearer(request, deps.config.cronSecret)) return json(401, { error: "unauthorized" });
  const before = (ms: number) => new Date(deps.clock() - ms).toISOString();
  const { store, accounts } = deps;
  const purgeUsers = async (): Promise<number> => {
    const [cutoff, stopAt] = [before(NO_ACCOUNT_KEPT_MS), deps.clock() + PURGE_MS];
    let purged = 0;
    for (let n = PURGE_BATCH; n === PURGE_BATCH && purged < PURGE_LIMIT && deps.clock() < stopAt; purged += n) {
      n = await accounts.purgeUsersWithoutAccount(cutoff, PURGE_BATCH);
    }
    return purged;
  };
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
  const [deleted, stripeEvents, usersWithoutAccount] = await Promise.all([
    step("store", async () => store.cleanup?.() ?? 0),
    step("stripe_events", () => accounts.pruneStripeEvents(before(STRIPE_EVENTS_KEPT_MS), PRUNE_LIMIT)),
    step("users_without_account", purgeUsers),
  ]);
  const counts = {
    deleted,
    ...(store.cleanup ? {} : { note: "This store drops expired entries on read." }),
    ...(stripeEvents > 0 ? { stripeEvents } : {}),
    ...(usersWithoutAccount > 0 ? { usersWithoutAccount } : {}),
  };
  if (failed.length === 0) return json(200, counts);
  await alertToday(deps, "cleanup", "The daily cleanup failed", `Failed steps: ${failed.join(", ")}. Expired data is kept until a run works.`);
  return json(503, { error: "unavailable", ...counts, failed });
}
