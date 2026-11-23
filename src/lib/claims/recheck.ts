import type { Claim } from "@/lib/accounts/data";
import type { ServerDeps } from "@/lib/server/runtime";
import { runClaimCheck } from "./verify";

/**
 * The daily recheck (GET /api/cron/claims, phase-3.md): verified and lapsed claims last checked more
 * than RECHECK_AFTER_S ago, least recently checked first, at most RECHECK_PER_RUN per run. A few
 * checks run at once; each meta check is paced per host and follows robots rules through the fetch
 * context. No check starts after RECHECK_BUDGET_MS, and no request after it either, so a run ends
 * well inside one 60 s function; the claims it did not reach stay due for the next run. Three
 * consecutive failures lapse a claim (AccountData recordClaimFailure); one pass restores it. Times
 * come from deps.clock.
 */

export const RECHECK_AFTER_S = 24 * 3600;
export const RECHECK_PER_RUN = 50;
/** No check or request starts after this; a started request ends within FETCH_TIMEOUT_MS (8 s). */
export const RECHECK_BUDGET_MS = 40_000;
const CONCURRENCY = 4;

export interface RecheckSummary {
  /** Checks that were recorded. */
  readonly checked: number;
  readonly verified: number;
  readonly failed: number;
  /** Failed checks that lapsed their claim now. */
  readonly lapsed: number;
  /** Due claims not checked in this run (the budget ran out, or the check was deferred). */
  readonly skipped: number;
  /** Checks whose record failed (account data unavailable). */
  readonly errors: number;
}

type Deps = Pick<ServerDeps, "config" | "accounts" | "clock" | "fetch" | "txt">;

/** Runs one recheck. Throws only when the due claims cannot be listed. */
export async function recheckDueClaims(deps: Deps): Promise<RecheckSummary> {
  const startedAt = deps.clock();
  const notAfter = startedAt + RECHECK_BUDGET_MS;
  const due = await deps.accounts.listClaimsDueForRecheck(new Date(startedAt - RECHECK_AFTER_S * 1000).toISOString(), RECHECK_PER_RUN);
  const tally = { checked: 0, verified: 0, failed: 0, lapsed: 0, skipped: 0, errors: 0 };
  const queue = [...due];

  async function one(claim: Claim): Promise<void> {
    if (deps.clock() >= notAfter) {
      tally.skipped++;
      return;
    }
    try {
      const { claim: after, checked } = await runClaimCheck(deps, claim, { notAfter });
      if (!checked) {
        tally.skipped++;
        return;
      }
      tally.checked++;
      if (after.status === "verified" && after.lastResult === "verified") tally.verified++;
      else tally.failed++;
      if (after.status === "lapsed" && claim.status !== "lapsed") tally.lapsed++;
    } catch (e) {
      tally.errors++;
      console.error("Claim recheck failed:", e instanceof Error ? e.name : "unknown error");
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      for (let next = queue.shift(); next; next = queue.shift()) await one(next);
    }),
  );
  return tally;
}
