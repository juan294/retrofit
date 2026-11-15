import { describe, expect, it, vi } from "vitest";
import { type FreeConfig, loadFreeConfig } from "@/lib/config";
import { HOLD_KEY, HOLD_TTL_S, createHold, describeFreeState, recordOverrun, resumeFree } from "@/lib/inference/hold";
import { createLedger } from "@/lib/inference/ledger";
import { createMemoryBacking, createMemoryStore } from "@/lib/store/memory";
import { fakeClock } from "../helpers/server-deps";

const DAY = 86_400_000;
const free: FreeConfig = loadFreeConfig({ FREE_CREDIT_USD: "10", JUDGE_RESERVE_USD: "3", FREE_SERVICE_END: "2026-11-24T23:59:59Z" }, false);
const START = Date.parse("2026-11-15T12:00:00Z");

/** One server instance: a store client over the shared backing, plus the modules built on it. */
function instance(backing: ReturnType<typeof createMemoryBacking>, clock: ReturnType<typeof fakeClock>) {
  const store = createMemoryStore({ clock: clock.now, backing });
  const deps = { store, config: free, clock: clock.now };
  return { store, deps, ledger: createLedger(deps), hold: createHold(deps) };
}

/** Public reservation of 700 000 micro-USD reported at 800 000: an overrun of 100 000. */
async function overrun(i: ReturnType<typeof instance>, alert = vi.fn(async () => {})) {
  const r = await i.ledger.reserve({ pool: "public", sid: "s", microUsd: 700_000 });
  if (!r.ok) throw new Error(`reserve refused: ${r.reason}`);
  const result = await i.ledger.reconcile(r.reservationId, 800_000);
  expect(result.overrun).toBe(true);
  await recordOverrun(i.deps, result, alert);
  return alert;
}

describe("overrun hold", () => {
  // Fails if an overrun does not write the hold record, or alerts more than once for repeated overruns.
  it("an overrun writes the hold and calls the alert once", async () => {
    const clock = fakeClock(START);
    const i = instance(createMemoryBacking(), clock);
    const alert = await overrun(i);
    expect(await i.hold.isHeld()).toBe(true);
    expect(await i.hold.read()).toEqual({ reason: "reservation_overrun", at: new Date(START).toISOString(), overrunMicroUsd: 100_000, reservationMicroUsd: 700_000 });
    expect(alert).toHaveBeenCalledTimes(1);
    expect(alert).toHaveBeenCalledWith({ key: "reservation-overrun", overrunMicroUsd: 100_000, reservationMicroUsd: 700_000 });

    // A judge overrun while held keeps the first record and does not alert again.
    const j = await i.ledger.reserve({ pool: "judge", sid: "j", microUsd: 1000 });
    if (!j.ok) throw new Error("judge refused");
    await recordOverrun(i.deps, await i.ledger.reconcile(j.reservationId, 5000), alert);
    expect(alert).toHaveBeenCalledTimes(1);
    expect((await i.hold.read())?.overrunMicroUsd).toBe(100_000);
  });

  // Fails if recordOverrun acts on a result that is not an overrun.
  it("does nothing for a normal reconciliation", async () => {
    const i = instance(createMemoryBacking(), fakeClock(START));
    const r = await i.ledger.reserve({ pool: "public", sid: "s", microUsd: 1000 });
    if (!r.ok) throw new Error("refused");
    const alert = vi.fn(async () => {});
    await recordOverrun(i.deps, await i.ledger.reconcile(r.reservationId, 900), alert);
    expect(alert).not.toHaveBeenCalled();
    expect(await i.hold.isHeld()).toBe(false);
  });

  // Fails if the hold expires with the UTC day (for example if the daily rollover clears it).
  it("keeps the public pool closed across a UTC rollover", async () => {
    const clock = fakeClock(START);
    const i = instance(createMemoryBacking(), clock);
    await overrun(i);
    clock.advance(3 * DAY);
    expect(await i.ledger.reserve({ pool: "public", sid: "s2", microUsd: 1 })).toEqual({ ok: false, reason: "hold" });
    expect(await i.hold.isHeld()).toBe(true);
  });

  // Fails if the hold lives only in process memory (a restart must not reopen the pool).
  it("keeps the public pool closed across a restart", async () => {
    const clock = fakeClock(START);
    const backing = createMemoryBacking();
    await overrun(instance(backing, clock));
    const restarted = instance(backing, clock);
    expect(await restarted.hold.isHeld()).toBe(true);
    expect(await restarted.ledger.reserve({ pool: "public", sid: "s2", microUsd: 1 })).toEqual({ ok: false, reason: "hold" });
  });

  // Fails if writeHold records the hold without closing the public pool in the ledger.
  it("writeHold closes the public pool", async () => {
    const i = instance(createMemoryBacking(), fakeClock(START));
    await i.hold.writeHold({ reason: "manual", overrunMicroUsd: 0, reservationMicroUsd: 0 });
    expect(await i.ledger.reserve({ pool: "public", sid: "s", microUsd: 1 })).toEqual({ ok: false, reason: "hold" });
  });

  // Fails if the hold record is written with a short TTL.
  it("stores the hold with a ten-year TTL", async () => {
    expect(HOLD_TTL_S).toBeGreaterThanOrEqual(10 * 365 * 86_400);
    const clock = fakeClock(START);
    const i = instance(createMemoryBacking(), clock);
    await overrun(i);
    clock.advance(9 * 365 * DAY);
    expect(await i.store.get(HOLD_KEY)).not.toBeNull();
  });

  // Fails if the hold also closes the judge pool, or the judge pool ignores its remaining budget.
  it("lets the judge pool keep serving while its budget allows", async () => {
    const i = instance(createMemoryBacking(), fakeClock(START));
    await overrun(i);
    const ok = await i.ledger.reserve({ pool: "judge", sid: "j", microUsd: 2_000_000 });
    expect(ok.ok).toBe(true);
    expect(await i.ledger.reserve({ pool: "judge", sid: "j", microUsd: 1_000_001 })).toEqual({ ok: false, reason: "judge_pool" });
  });
});

describe("resumeFree", () => {
  async function held() {
    const clock = fakeClock(START);
    const i = instance(createMemoryBacking(), clock);
    await overrun(i);
    return { clock, i };
  }

  // Fails if the hold can be removed without the owner's reconciled balance.
  it("refuses without a balance or a note", async () => {
    const { i } = await held();
    for (const input of [
      { reconciledBalanceUsd: undefined, note: "checked" },
      { reconciledBalanceUsd: Number.NaN, note: "checked" },
      { reconciledBalanceUsd: -1, note: "checked" },
      { reconciledBalanceUsd: 9.2, note: "  " },
    ]) {
      const r = await resumeFree(i.deps, input);
      expect(r.ok).toBe(false);
    }
    expect(await i.hold.isHeld()).toBe(true);
  });

  // Fails if resumption is allowed when the provider balance is below what the ledger says remains.
  it("refuses a balance below the ledger's remaining credit", async () => {
    const { i } = await held();
    // Spent 800 000 of 10 000 000: 9.2 USD remains by the ledger.
    const r = await resumeFree(i.deps, { reconciledBalanceUsd: 9.199999, note: "provider balance" });
    expect(r).toMatchObject({ ok: false, reason: "balance_below_ledger" });
    expect(await i.hold.isHeld()).toBe(true);
    expect(await i.ledger.reserve({ pool: "public", sid: "s", microUsd: 1 })).toEqual({ ok: false, reason: "hold" });
  });

  // Fails if a valid resume leaves the hold, writes no audit record, or does not reopen the public pool.
  it("with a valid balance removes the hold and writes the audit record", async () => {
    const { clock, i } = await held();
    clock.advance(60_000);
    const r = await resumeFree(i.deps, { reconciledBalanceUsd: 9.2, note: "Bound raised; balance checked on Otari" });
    expect(r).toMatchObject({ ok: true });
    if (!r.ok) return;
    expect(r.auditKey).toBe(`inference:audit:${new Date(START + 60_000).toISOString()}`);
    expect(await i.hold.isHeld()).toBe(false);
    const audit = await i.store.get<Record<string, unknown>>(r.auditKey);
    expect(audit).toMatchObject({
      note: "Bound raised; balance checked on Otari",
      reconciledBalanceMicroUsd: 9_200_000,
      ledgerRemainingMicroUsd: 9_200_000,
      totalSpentMicroUsd: 800_000,
      hold: { reason: "reservation_overrun", overrunMicroUsd: 100_000 },
    });
    // Today's public budget is already spent (800 000 > 700 000); the next UTC day reopens it.
    clock.advance(DAY);
    expect((await i.ledger.reserve({ pool: "public", sid: "s", microUsd: 1 })).ok).toBe(true);
  });

  // Fails if resume reports success when there is no hold to remove.
  it("refuses when no hold exists", async () => {
    const i = instance(createMemoryBacking(), fakeClock(START));
    expect(await resumeFree(i.deps, { reconciledBalanceUsd: 10, note: "x" })).toMatchObject({ ok: false, reason: "not_held" });
  });

  // Fails if the state printed for the owner omits the ledger total, outstanding reservations, the hold or the bound.
  it("describes the ledger, hold and bound parameters", async () => {
    const { i } = await held();
    await i.ledger.reserve({ pool: "judge", sid: "j", microUsd: 5000 });
    const state = await describeFreeState(i.deps);
    expect(state).toMatchObject({
      totalSpentMicroUsd: 800_000,
      totalOutstandingMicroUsd: 5000,
      ledgerRemainingMicroUsd: 10_000_000 - 805_000,
      hold: { reservationMicroUsd: 700_000 },
      bound: { priceInPerM: free.priceInPerM, priceOutPerM: free.priceOutPerM, framingTokensBase: 512, framingTokensPerMessage: 16, maxTokens: 1024 },
    });
  });
});
