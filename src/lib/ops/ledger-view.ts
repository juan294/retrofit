import { createHold, holdId } from "../inference/hold";
import { createLedger, utcDay } from "../inference/ledger";
import type { ServerDeps } from "../server/runtime";

/** Ledger totals the credit check reads, in micro-USD. Outstanding means reserved and not yet reconciled. */
export interface LedgerView {
  readonly totalSpentMicro: number;
  readonly totalOutstandingMicro: number;
  readonly judgeSpentMicro: number;
  /**
   * The current hold's id while the public pool is held, else null. A ledger
   * hold flag without a hold record (the record write never ran) gets
   * `unrecorded-<UTC day>`, so the owner is alerted daily until it is reconciled.
   */
  readonly holdId?: string | null;
}

/** Reads the totals from the free-path ledger (`src/lib/inference/ledger.ts`). Throws CountersUnavailable when the store fails (the cron route answers 503). */
export async function ledgerViewFor(deps: Pick<ServerDeps, "store" | "config" | "clock">): Promise<LedgerView> {
  const counterDeps = { store: deps.store, config: deps.config.free, clock: deps.clock };
  const b = await createLedger(counterDeps).budgets();
  const record = await createHold(counterDeps).read();
  const id = record ? holdId(record) : b.held ? `unrecorded-${utcDay(deps.clock())}` : null;
  return { totalSpentMicro: b.totalSpentMicro, totalOutstandingMicro: b.totalOutstandingMicro, judgeSpentMicro: b.judgeSpentMicro, holdId: id };
}
