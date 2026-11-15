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
 *
 * Judge requests keep running while the public pool is held, so a new overrun
 * can settle while the owner resumes. Every overrun and every hold write counts
 * a hold event in the ledger document, and resumption clears the flag with one
 * compare-and-set that requires the hold-event count it inspected. The hold
 * record is removed before that compare-and-set and restored when it refuses or
 * fails, so a hold event at any point keeps the hold.
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

    /**
     * Idempotent: the first record is kept. Returns whether this call created it.
     * The ledger flag is raised first, so a resumption that runs concurrently
     * either sees the hold event (and refuses) or has already removed the old
     * record (and this call creates a new one, with its alert).
     */
    async writeHold(input: Omit<HoldRecord, "at">): Promise<{ created: boolean }> {
      const record: HoldRecord = { ...input, at: new Date(clock()).toISOString() };
      await ledger.raiseHold();
      const { created } = await guarded("hold", () => store.putIfAbsent(HOLD_KEY, record, HOLD_TTL_S));
      return { created };
    },

    /**
     * Writes the audit record, removes the hold record, then clears the ledger
     * flag only while the ledger still matches the inspected hold-event count and
     * the balance covers its remaining credit. On a refusal or a failure the
     * inspected record is restored (a newer record is kept) and the hold stays.
     */
    async removeHold(input: {
      expectedHoldEvents: number;
      reconciledBalanceMicro: number;
      record: HoldRecord | null;
      audit: Record<string, unknown>;
    }): Promise<{ ok: true; auditKey: string } | { ok: false; auditKey: string; reason: "hold_changed" | "balance_below_ledger" }> {
      const auditKey = await writeAudit(input.audit);
      const restore = async () => {
        if (input.record) await guarded("hold", () => store.putIfAbsent(HOLD_KEY, input.record, HOLD_TTL_S));
      };
      await guarded("hold", () => store.delete(HOLD_KEY));
      let cleared: Awaited<ReturnType<typeof ledger.clearHold>>;
      try {
        cleared = await ledger.clearHold(input.expectedHoldEvents, input.reconciledBalanceMicro);
      } catch (error) {
        await restore();
        throw error;
      }
      if (cleared.ok) return { ok: true, auditKey };
      await restore();
      await writeAudit({ action: "resume-free-refused", attempt: auditKey, reason: cleared.reason });
      return { ok: false, auditKey, reason: cleared.reason };
    },
  };

  /** Writes one audit record under a new `inference:audit:<time>[-n]` key and returns the key. */
  function writeAudit(audit: Record<string, unknown>): Promise<string> {
    const stamp = new Date(clock()).toISOString();
    return guarded("audit", async () => {
      for (let n = 0; ; n++) {
        const key = `${AUDIT_PREFIX}${stamp}${n ? `-${n}` : ""}`;
        if ((await store.putIfAbsent(key, { ...audit, at: stamp }, HOLD_TTL_S)).created) return key;
      }
    });
  }
}

/** The id of a hold, used in its alert key (`overrun:<id>`): the hold time in ms. */
export const holdId = (record: Pick<HoldRecord, "at">): string => String(Date.parse(record.at));

/**
 * Called by the proxy after reconcile. On an overrun, or when the reported
 * prompt tokens exceed the reservation's input bound (the byte-tokenizer
 * assumption failed even if the unused output allowance hides it in the
 * total), it writes the hold and alerts once: a repeated breach while the hold
 * exists does not alert again. The daily credit check retries a failed alert.
 */
export async function recordOverrun(deps: HoldDeps, result: ReconcileResult, alert: OverrunAlert, options: { inputBoundExceeded?: boolean } = {}): Promise<void> {
  if (!result.overrun && !options.inputBoundExceeded) return;
  const { created } = await createHold(deps).writeHold({
    reason: result.overrun ? "reservation_overrun" : "input_tokens_above_bound",
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
  /** The ledger's hold-event count at inspection; resumption requires it unchanged. */
  readonly holdEvents: number;
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
    holdEvents: b.holdEvents,
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
  | { ok: false; reason: "no_balance" | "no_note" | "not_held" | "balance_below_ledger" | "hold_changed"; message: string; state?: FreeState; auditKey?: string };

const BALANCE_BELOW_LEDGER = "The entered balance is below the ledger's remaining credit. Reconcile the ledger, prices and bound before resuming.";
const HOLD_CHANGED =
  "A new overrun or hold was recorded while resuming, so the hold stays in place. Inspect the new state, reconcile again and rerun the command.";

/**
 * Removes the hold after the owner's reconciliation. Refuses without a balance or
 * note, when no hold exists, and when the entered provider balance is below the
 * ledger's remaining credit (the ledger would then be under-counting spend),
 * checked again at the moment the hold is cleared. Refuses, keeping the hold,
 * when a hold event happens after inspection (a concurrent judge overrun).
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
    return { ok: false, reason: "balance_below_ledger", message: BALANCE_BELOW_LEDGER, state };
  }
  const removed = await createHold(deps).removeHold({
    expectedHoldEvents: state.holdEvents,
    reconciledBalanceMicro: balanceMicro,
    record: state.hold,
    audit: {
      action: "resume-free",
      note,
      reconciledBalanceMicroUsd: balanceMicro,
      ledgerRemainingMicroUsd: state.ledgerRemainingMicroUsd,
      totalSpentMicroUsd: state.totalSpentMicroUsd,
      totalOutstandingMicroUsd: state.totalOutstandingMicroUsd,
      holdEvents: state.holdEvents,
      hold: state.hold,
      bound: state.bound,
    },
  });
  if (removed.ok) return { ok: true, auditKey: removed.auditKey, state };
  const message = removed.reason === "hold_changed" ? HOLD_CHANGED : BALANCE_BELOW_LEDGER;
  return { ok: false, reason: removed.reason, message, state, auditKey: removed.auditKey };
}
