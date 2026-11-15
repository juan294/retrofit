import { randomUUID } from "node:crypto";
import type { FreeConfig } from "@/lib/config";
import { utcDay } from "@/lib/fetch/limits";
import type { Clock, Store } from "@/lib/store/types";
import { CountersUnavailable, guarded } from "./errors";

/**
 * Spend ledger for the free path (phase 6, "Ledger and quotas"). Amounts are integer micro-USD.
 *
 * One versioned document, `inference:ledger:state`, holds the running totals, the
 * current UTC day's public budget and spend, every outstanding reservation, the
 * hold flag and the hold record. Every change is one compareAndSet on that document, so a reservation
 * is checked against the budgets, the outstanding reservations and the hold in a
 * single atomic step: two requests can never both take the last part of a budget.
 *
 * Reservations are only ever settled as spend (reconcile, or in full when stale).
 * There is deliberately no way to release a reservation without charging it: a
 * visitor disconnect keeps the reservation because the provider may already charge.
 */

export type Pool = "public" | "judge";

export interface LedgerDeps {
  readonly store: Store;
  /** The free-path settings (`Config.free`). */
  readonly config: FreeConfig;
  readonly clock: Clock;
}

/** The ledger, hold and quota deps from the server deps. */
export const counterDepsOf = (deps: { readonly store: Store; readonly config: { readonly free: FreeConfig }; readonly clock: Clock }): LedgerDeps => ({
  store: deps.store,
  config: deps.config.free,
  clock: deps.clock,
});

export type ReserveResult = { ok: true; reservationId: string } | { ok: false; reason: "public_pool" | "judge_pool" | "ledger" | "hold" };

export interface ReconcileResult {
  /** False when the reservation was already reconciled or settled as stale. */
  readonly found: boolean;
  readonly overrun: boolean;
  /** Amount added to spend: the reported usage, or the full reservation when usage is missing. */
  readonly chargedMicroUsd: number;
  readonly reservationMicroUsd: number;
  /** Reported usage above the reservation; 0 when there is no overrun. */
  readonly overrunMicroUsd: number;
  /** True when this overrun wrote the hold record (no hold record existed): the caller alerts once. */
  readonly holdCreated: boolean;
}

/** The overrun hold's details for the owner, kept in the ledger document with the hold flag. */
export interface HoldRecord {
  readonly reason: string;
  /** ISO time the hold was written. */
  readonly at: string;
  readonly overrunMicroUsd: number;
  readonly reservationMicroUsd: number;
}

export interface Budgets {
  readonly publicDailyMicro: number;
  readonly publicSpentTodayMicro: number;
  readonly judgeRemainingMicro: number;
  readonly totalSpentMicro: number;
  /** Judge-pool spend so far (the credit check's judge share). */
  readonly judgeSpentMicro: number;
  readonly totalOutstandingMicro: number;
  /** Credit minus total spend and outstanding reservations. */
  readonly remainingCreditMicro: number;
  readonly held: boolean;
  /** Count of hold events (overruns and hold writes). Resumption clears the hold only while it is unchanged. */
  readonly holdEvents: number;
  readonly hold: HoldRecord | null;
}

export type ClearHoldResult = { ok: true } | { ok: false; reason: "hold_changed" | "balance_below_ledger" };

interface StoredReservation {
  pool: Pool;
  sid: string;
  microUsd: number;
  /** UTC day (YYYY-MM-DD) the reservation was taken on. */
  day: string;
  at: number;
}

interface LedgerState {
  version: number;
  /** UTC day the daily budget below belongs to; "" before the first day. */
  day: string;
  publicDailyMicro: number;
  publicSpentTodayMicro: number;
  spent: Record<Pool, number>;
  reservations: Record<string, StoredReservation>;
  held: boolean;
  /** Incremented by every overrun and every raiseHold. Absent in documents written before it existed. */
  holdEvents?: number;
  /** The hold record; set with the flag in the same write and cleared with it. */
  hold?: HoldRecord | null;
}

export const LEDGER_KEY = "inference:ledger:state";
/** The store has no "no expiry" option; ten years outlives the free period by far. */
export const LEDGER_TTL_S = 10 * 365 * 86_400;
/** A reservation older than this cannot belong to a running request (maxDuration 60 s); it is charged in full. */
export const RESERVATION_STALE_MS = 10 * 60_000;
const MAX_ATTEMPTS = 32;
const DAY_MS = 86_400_000;

export const toMicro = (usd: number): number => Math.round(usd * 1_000_000);

/** UTC days from today through the day of `serviceEndMs`, at least 1. */
export function daysLeft(serviceEndMs: number, now: number): number {
  const startOfToday = Math.floor(now / DAY_MS) * DAY_MS;
  return Math.max(1, Math.ceil((serviceEndMs - startOfToday) / DAY_MS));
}

const emptyState = (): LedgerState => ({
  version: 0,
  day: "",
  publicDailyMicro: 0,
  publicSpentTodayMicro: 0,
  spent: { public: 0, judge: 0 },
  reservations: {},
  held: false,
  holdEvents: 0,
  hold: null,
});

function outstanding(state: LedgerState, pool?: Pool, day?: string): number {
  let sum = 0;
  for (const r of Object.values(state.reservations)) {
    if ((pool === undefined || r.pool === pool) && (day === undefined || r.day === day)) sum += r.microUsd;
  }
  return sum;
}

/** Moves a reservation to spend. Mutates `state`. */
function settle(state: LedgerState, id: string, chargedMicro: number): void {
  const r = state.reservations[id]!;
  delete state.reservations[id];
  state.spent[r.pool] += chargedMicro;
  if (r.pool === "public" && r.day === state.day) state.publicSpentTodayMicro += chargedMicro;
}

export function createLedger(deps: LedgerDeps) {
  const { store, clock, config: free } = deps;
  const creditMicro = toMicro(free.creditUsd);
  const reserveMicro = toMicro(free.judgeReserveUsd);

  /** Applies time: settles stale reservations, then starts a new UTC day with its public budget. Mutates `state`. */
  function advance(state: LedgerState, now: number): void {
    for (const [id, r] of Object.entries(state.reservations)) {
      if (now - r.at > RESERVATION_STALE_MS) settle(state, id, r.microUsd);
    }
    const today = utcDay(now);
    if (state.day === today) return;
    state.day = today;
    state.publicSpentTodayMicro = 0;
    const available = Math.max(0, creditMicro - reserveMicro - state.spent.public - outstanding(state, "public"));
    state.publicDailyMicro = Math.floor(available / daysLeft(free.serviceEndMs, now));
  }

  /** Sets the flag, counts a hold event and writes the record when none exists. Returns whether it wrote the record. Mutates `state`. */
  function hold(state: LedgerState, record?: Omit<HoldRecord, "at">): boolean {
    state.held = true;
    state.holdEvents = (state.holdEvents ?? 0) + 1;
    if (!record || state.hold) return false;
    state.hold = { ...record, at: new Date(clock()).toISOString() };
    return true;
  }

  const totals = (s: LedgerState) => {
    const totalSpent = s.spent.public + s.spent.judge;
    const totalOutstanding = outstanding(s);
    return { totalSpent, totalOutstanding, remainingCredit: creditMicro - totalSpent - totalOutstanding };
  };

  async function load(): Promise<LedgerState> {
    const current = await store.get<LedgerState>(LEDGER_KEY);
    if (current) return current;
    return (await store.putIfAbsent(LEDGER_KEY, emptyState(), LEDGER_TTL_S)).value;
  }

  /**
   * Read-modify-write with compareAndSet. `change` mutates a copy of the state
   * (after time is applied) and returns its result; returning `write: false`
   * skips the write when nothing changed.
   */
  async function update<R>(what: string, change: (state: LedgerState) => { result: R; write: boolean }): Promise<R> {
    return guarded(what, async () => {
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const current = await load();
        const next = structuredClone(current);
        const before = JSON.stringify(next);
        advance(next, clock());
        const { result, write } = change(next);
        if (!write && JSON.stringify(next) === before) return result;
        next.version = current.version + 1;
        if (await store.compareAndSet(LEDGER_KEY, current, next, LEDGER_TTL_S)) return result;
      }
      throw new CountersUnavailable(`inference counters unavailable (${what}: compare-and-set did not settle)`);
    });
  }

  return {
    /** Reserves `microUsd` for one request. Refuses when the pool, the credit or the hold does not allow it. */
    reserve(input: { pool: Pool; sid: string; microUsd: number }): Promise<ReserveResult> {
      const { pool, sid, microUsd } = input;
      if (!Number.isSafeInteger(microUsd) || microUsd <= 0) return Promise.reject(new RangeError("microUsd must be a positive integer"));
      return update<ReserveResult>("reserve", (s) => {
        const refuse = (reason: "public_pool" | "judge_pool" | "ledger" | "hold") => ({ result: { ok: false as const, reason }, write: false });
        const { remainingCredit } = totals(s);
        if (pool === "public") {
          if (s.held) return refuse("hold");
          if (microUsd > remainingCredit) return refuse("ledger");
          const publicCapLeft = creditMicro - reserveMicro - s.spent.public - outstanding(s, "public");
          const todayLeft = s.publicDailyMicro - s.publicSpentTodayMicro - outstanding(s, "public", s.day);
          if (microUsd > publicCapLeft || microUsd > todayLeft) return refuse("public_pool");
        } else {
          const judgeLeft = reserveMicro - s.spent.judge - outstanding(s, "judge");
          if (microUsd > Math.min(judgeLeft, remainingCredit)) return refuse(remainingCredit < judgeLeft ? "ledger" : "judge_pool");
        }
        const reservationId = randomUUID();
        s.reservations[reservationId] = { pool, sid, microUsd, day: s.day, at: clock() };
        return { result: { ok: true, reservationId }, write: true };
      });
    },

    /**
     * Records the outcome of a reserved request. `reportedMicroUsd` null (usage
     * missing) charges the full reservation. A reported amount is always charged
     * as reported, never less; above the reservation it is an overrun, which also
     * sets the hold flag in the same write so the public pool closes at once. The
     * caller then writes the hold record and alerts (hold.ts, recordOverrun).
     */
    reconcile(reservationId: string, reportedMicroUsd: number | null): Promise<ReconcileResult> {
      if (reportedMicroUsd !== null && (!Number.isSafeInteger(reportedMicroUsd) || reportedMicroUsd < 0)) {
        return Promise.reject(new RangeError("reportedMicroUsd must be a non-negative integer or null"));
      }
      return update<ReconcileResult>("reconcile", (s) => {
        const r = s.reservations[reservationId];
        if (!r) {
          return { result: { found: false, overrun: false, chargedMicroUsd: 0, reservationMicroUsd: 0, overrunMicroUsd: 0, holdCreated: false }, write: false };
        }
        const charged = reportedMicroUsd ?? r.microUsd;
        const overrunMicroUsd = Math.max(0, charged - r.microUsd);
        settle(s, reservationId, charged);
        const holdCreated = overrunMicroUsd > 0 && hold(s, { reason: "reservation_overrun", overrunMicroUsd, reservationMicroUsd: r.microUsd });
        return {
          result: { found: true, overrun: overrunMicroUsd > 0, chargedMicroUsd: charged, reservationMicroUsd: r.microUsd, overrunMicroUsd, holdCreated },
          write: true,
        };
      });
    },

    /** Current budgets, with time applied (a new UTC day or stale reservations) but not written. */
    budgets(): Promise<Budgets> {
      return guarded("budgets", async () => {
        const s = structuredClone(await load());
        advance(s, clock());
        const { totalSpent, totalOutstanding, remainingCredit } = totals(s);
        const judgeLeft = reserveMicro - s.spent.judge - outstanding(s, "judge");
        return {
          publicDailyMicro: s.publicDailyMicro,
          publicSpentTodayMicro: s.publicSpentTodayMicro,
          judgeRemainingMicro: Math.max(0, Math.min(judgeLeft, remainingCredit)),
          totalSpentMicro: totalSpent,
          judgeSpentMicro: s.spent.judge,
          totalOutstandingMicro: totalOutstanding,
          remainingCreditMicro: remainingCredit,
          held: s.held,
          holdEvents: s.holdEvents ?? 0,
          hold: s.hold ?? null,
        };
      });
    },

    /**
     * Sets the hold flag that closes the public pool and counts a hold event,
     * even when the flag is already set, so a resumption that inspected the
     * ledger before this call cannot clear it. Writes `record` in the same
     * compare-and-set when no hold record exists. Used by hold.ts only.
     */
    raiseHold(record?: Omit<HoldRecord, "at">): Promise<{ created: boolean }> {
      return update("hold", (s) => ({ result: { created: hold(s, record) }, write: true }));
    },

    /**
     * Clears the hold flag and record in one compare-and-set, only while no hold
     * event has happened since `expectedHoldEvents` was read and the owner's
     * reconciled balance still covers the ledger's remaining credit. Used by hold.ts only.
     */
    clearHold(expectedHoldEvents: number, reconciledBalanceMicro: number): Promise<ClearHoldResult> {
      return update<ClearHoldResult>("hold", (s) => {
        const refuse = (reason: "hold_changed" | "balance_below_ledger") => ({ result: { ok: false as const, reason }, write: false });
        if ((s.holdEvents ?? 0) !== expectedHoldEvents) return refuse("hold_changed");
        if (reconciledBalanceMicro < totals(s).remainingCredit) return refuse("balance_below_ledger");
        s.held = false;
        s.hold = null;
        return { result: { ok: true }, write: true };
      });
    },
  };
}

export type Ledger = ReturnType<typeof createLedger>;
