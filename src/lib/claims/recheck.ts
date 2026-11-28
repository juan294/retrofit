import type { Claim } from "@/lib/accounts/data";
import type { ServerDeps } from "@/lib/server/runtime";
import { CHECK_DEADLINE_MS, runClaimCheck } from "./verify";

/**
 * The daily recheck (GET /api/cron/claims, phase-3.md): the due claims (AccountData
 * listClaimsDueForRecheck: verified first, then lapsed, a long-lapsed claim only weekly), at most
 * RECHECK_PER_RUN per run; a run with more due logs that (counts only). A few
 * checks run at once; each meta check is paced per host and follows robots rules through the fetch
 * context. No check starts after RECHECK_BUDGET_MS, and no request after it either, so a run ends
 * well inside one 60 s function; the claims it did not reach stay due for the next run, and a claim whose check
 * was deferred goes behind them. Three
 * consecutive failures lapse a claim (AccountData recordClaimFailure); one pass restores it. Times
 * come from deps.clock.
 */

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

type Deps = Pick<ServerDeps, "config" | "accounts" | "clock" | "fetch" | "txt" | "sleep">;

/** Runs one recheck. Throws only when the due claims cannot be listed. */
export async function recheckDueClaims(deps: Deps): Promise<RecheckSummary> {
  const startedAt = deps.clock();
  const notAfter = startedAt + RECHECK_BUDGET_MS;
  // The longest wait is a visitor's own (CHECK_DEADLINE_MS): a longer Crawl-delay fails both, so it cannot be deferred forever.
  const deadline = { notAfter, maxWaitMs: CHECK_DEADLINE_MS, startedBy: "recheck" } as const;
  // One more than a run checks, to know whether some must wait for the next run.
  const due = await deps.accounts.listClaimsDueForRecheck(new Date(startedAt).toISOString(), RECHECK_PER_RUN + 1);
  if (due.length > RECHECK_PER_RUN) console.warn(`Claim recheck: more than ${RECHECK_PER_RUN} claims were due; the rest wait for the next run.`);
  const tally = { checked: 0, verified: 0, failed: 0, lapsed: 0, skipped: 0, errors: 0 };
  const queue = due.slice(0, RECHECK_PER_RUN);

  async function one(claim: Claim): Promise<void> {
    if (deps.clock() >= notAfter) {
      tally.skipped++;
      return;
    }
    try {
      const { claim: after, checked, deferred } = await runClaimCheck(deps, claim, deadline);
      // Nothing was checked: the claim stays due, behind the claims that were not tried yet.
      if (deferred) await deps.accounts.recordClaimAttempt(claim.id, new Date(deps.clock()).toISOString());
      if (!checked) {
        tally.skipped++;
        return;
      }
      tally.checked++;
      // A recorded check that left the claim verified passed (a failure never keeps lastResult "verified").
      if (after.lastResult === "verified") tally.verified++;
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
