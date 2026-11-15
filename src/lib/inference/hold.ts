import type { FreeConfig } from "@/lib/config";
import type { Clock, Store } from "@/lib/store/types";
import { guarded } from "./errors";
import { type ReconcileResult, createLedger, toMicro } from "./ledger";

/**
 * Overrun hold (parent plan, "Spend control"; phase 6, "Ledger and quotas").
 *
 * `inference:hold` is a persistent record with no expiry. The store contract has
 * no "no TTL" option, so it is written with a ten-year TTL, which outlives the
 * free period (to 2027-01-18) by far. The hold closes the public pool through
 * the ledger's hold flag, which the ledger sets in the same atomic write that
 * records an overrun; the record carries the details for the owner. Only
 * `resumeFree` (run through `pnpm ops:resume-free`) removes both. Nothing
 * reopens the pool by itself: not a UTC rollover, not a restart.
 */

export interface HoldRecord {
  readonly reason: string;
  /** ISO time the hold was written. */
  readonly at: string;
  readonly overrunMicroUsd: number;
  readonly reservationMicroUsd: number;
}

export interface HoldDeps {
  readonly store: Store;
  readonly config: FreeConfig;
  readonly clock: Clock;
}

export const HOLD_KEY = "inference:hold";
export const HOLD_TTL_S = 10 * 365 * 86_400;
export const AUDIT_PREFIX = "inference:audit:";

/** Alert callback for an overrun (src/lib/ops/alert.ts opens the GitHub issue). */
export type OverrunAlert = (details: { key: "reservation-overrun"; overrunMicroUsd: number; reservationMicroUsd: number }) => Promise<void>;

export function createHold(deps: HoldDeps) {
  const { store, clock } = deps;
  const ledger = createLedger(deps);

  return {
    read(): Promise<HoldRecord | null> {
      return guarded("hold", () => store.get<HoldRecord>(HOLD_KEY));
    },

    /** True while the record or the ledger flag exists. */
    async isHeld(): Promise<boolean> {
      const record = await guarded("hold", () => store.get<HoldRecord>(HOLD_KEY));
      return record !== null || (await ledger.budgets()).held;
    },

    /** Idempotent: the first record is kept. Returns whether this call created it. */
    async writeHold(input: Omit<HoldRecord, "at">): Promise<{ created: boolean }> {
      const record: HoldRecord = { ...input, at: new Date(clock()).toISOString() };
      const { created } = await guarded("hold", () => store.putIfAbsent(HOLD_KEY, record, HOLD_TTL_S));
      await ledger.setHeld(true);
      return { created };
    },

    /** Writes the audit record, then removes the hold. Returns the audit key. */
    async removeHold(audit: Record<string, unknown>): Promise<string> {
      const stamp = new Date(clock()).toISOString();
      const auditKey = await guarded("audit", async () => {
        for (let n = 0; ; n++) {
          const key = `${AUDIT_PREFIX}${stamp}${n ? `-${n}` : ""}`;
          if ((await store.putIfAbsent(key, { ...audit, at: stamp }, HOLD_TTL_S)).created) return key;
        }
      });
      await ledger.setHeld(false);
      await guarded("hold", () => store.delete(HOLD_KEY));
      return auditKey;
    },
  };
}

/**
 * Called by the proxy after reconcile. On an overrun it writes the hold and
 * alerts once: a repeated overrun while the hold exists does not alert again.
 */
export async function recordOverrun(deps: HoldDeps, result: ReconcileResult, alert: OverrunAlert): Promise<void> {
  if (!result.overrun) return;
  const { created } = await createHold(deps).writeHold({
    reason: "reservation_overrun",
    overrunMicroUsd: result.overrunMicroUsd,
    reservationMicroUsd: result.reservationMicroUsd,
  });
  if (created) await alert({ key: "reservation-overrun", overrunMicroUsd: result.overrunMicroUsd, reservationMicroUsd: result.reservationMicroUsd });
}

export interface FreeState {
  readonly totalSpentMicroUsd: number;
  readonly totalOutstandingMicroUsd: number;
  readonly ledgerRemainingMicroUsd: number;
  readonly creditMicroUsd: number;
  readonly hold: HoldRecord | null;
  readonly held: boolean;
  readonly bound: {
    readonly priceInPerM: number;
    readonly priceOutPerM: number;
    readonly perRequestFeeUsd: number;
    readonly framingTokensPerMessage: number;
    readonly framingTokensBase: number;
    readonly maxTokens: number;
    readonly maxBodyBytes: number;
    readonly maxMessages: number;
    readonly maxTools: number;
    readonly maxToolBytes: number;
  };
}

/** What `resume-free` prints for the owner before any change. */
export async function describeFreeState(deps: HoldDeps): Promise<FreeState> {
  const f = deps.config;
  const b = await createLedger(deps).budgets();
  return {
    totalSpentMicroUsd: b.totalSpentMicro,
    totalOutstandingMicroUsd: b.totalOutstandingMicro,
    ledgerRemainingMicroUsd: b.remainingCreditMicro,
    creditMicroUsd: toMicro(f.creditUsd),
    hold: await createHold(deps).read(),
    held: b.held,
    bound: {
      priceInPerM: f.priceInPerM,
      priceOutPerM: f.priceOutPerM,
      perRequestFeeUsd: f.perRequestFeeUsd,
      framingTokensPerMessage: f.framingTokensPerMessage,
      framingTokensBase: f.framingTokensBase,
      maxTokens: f.maxTokens,
      maxBodyBytes: f.maxBodyBytes,
      maxMessages: f.maxMessages,
      maxTools: f.maxTools,
      maxToolBytes: f.maxToolBytes,
    },
  };
}

export type ResumeResult =
  | { ok: true; auditKey: string; state: FreeState }
  | { ok: false; reason: "no_balance" | "no_note" | "not_held" | "balance_below_ledger"; message: string; state?: FreeState };

/**
 * Removes the hold after the owner's reconciliation. Refuses without a balance or
 * note, when no hold exists, and when the entered provider balance is below the
 * ledger's remaining credit (the ledger would then be under-counting spend).
 */
export async function resumeFree(deps: HoldDeps, input: { reconciledBalanceUsd?: number; note?: string }): Promise<ResumeResult> {
  const balance = input.reconciledBalanceUsd;
  if (typeof balance !== "number" || !Number.isFinite(balance) || balance < 0) {
    return { ok: false, reason: "no_balance", message: "Enter the reconciled provider balance in USD (--reconciled-balance <usd>)." };
  }
  const note = input.note?.trim();
  if (!note) return { ok: false, reason: "no_note", message: "Enter a note that records the reconciliation (--note <text>)." };

  const state = await describeFreeState(deps);
  if (!state.held && !state.hold) return { ok: false, reason: "not_held", message: "There is no hold to remove.", state };
  const balanceMicro = toMicro(balance);
  if (balanceMicro < state.ledgerRemainingMicroUsd) {
    return {
      ok: false,
      reason: "balance_below_ledger",
      message: "The entered balance is below the ledger's remaining credit. Reconcile the ledger, prices and bound before resuming.",
      state,
    };
  }
  const auditKey = await createHold(deps).removeHold({
    action: "resume-free",
    note,
    reconciledBalanceMicroUsd: balanceMicro,
    ledgerRemainingMicroUsd: state.ledgerRemainingMicroUsd,
    totalSpentMicroUsd: state.totalSpentMicroUsd,
    totalOutstandingMicroUsd: state.totalOutstandingMicroUsd,
    hold: state.hold,
    bound: state.bound,
  });
  return { ok: true, auditKey, state };
}
