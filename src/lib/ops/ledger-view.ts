import { createLedger } from "../inference/ledger";
import type { ServerDeps } from "../server/runtime";

/** Ledger totals the credit check reads, in micro-USD. Outstanding means reserved and not yet reconciled. */
export interface LedgerView {
  readonly totalSpentMicro: number;
  readonly totalOutstandingMicro: number;
  readonly judgeSpentMicro: number;
}

/** Reads the totals from the free-path ledger (`src/lib/inference/ledger.ts`). Throws CountersUnavailable when the store fails (the cron route answers 503). */
export async function ledgerViewFor(deps: Pick<ServerDeps, "store" | "config" | "clock">): Promise<LedgerView> {
  const b = await createLedger({ store: deps.store, config: deps.config.free, clock: deps.clock }).budgets();
  return { totalSpentMicro: b.totalSpentMicro, totalOutstandingMicro: b.totalOutstandingMicro, judgeSpentMicro: b.judgeSpentMicro };
}
