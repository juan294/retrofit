import { describe, expect, it, vi } from "vitest";
import { type FreeConfig, loadFreeConfig } from "@/lib/config";
import { AUDIT_PREFIX, HOLD_TTL_S, LEGACY_HOLD_KEY, type OverrunAlert, createHold, describeFreeState, recordOverrun, resumeFree } from "@/lib/inference/hold";
import { LEDGER_KEY, LEDGER_TTL_S, createLedger } from "@/lib/inference/ledger";
import { createMemoryBacking, createMemoryStore } from "@/lib/store/memory";
import type { Store } from "@/lib/store/types";
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

  // Fails if the hold record (kept in the ledger document) or the audit records are written with a short TTL.
  it("stores the hold with a ten-year TTL", async () => {
    expect(HOLD_TTL_S).toBeGreaterThanOrEqual(10 * 365 * 86_400);
    expect(LEDGER_TTL_S).toBeGreaterThanOrEqual(10 * 365 * 86_400);
    const clock = fakeClock(START);
    const i = instance(createMemoryBacking(), clock);
    await overrun(i);
    clock.advance(9 * 365 * DAY);
    expect(await i.hold.read()).toMatchObject({ reason: "reservation_overrun" });
    expect(await i.hold.isHeld()).toBe(true);
  });

  // Fails if a hold record written by the earlier separate-key layout no longer holds the pool, or survives resumption.
  it("treats a legacy separate hold record as held until resumed", async () => {
    const i = instance(createMemoryBacking(), fakeClock(START));
    const legacy = { reason: "reservation_overrun", at: new Date(START).toISOString(), overrunMicroUsd: 1, reservationMicroUsd: 1 };
    await i.store.set(LEGACY_HOLD_KEY, legacy, HOLD_TTL_S);
    expect(await i.hold.isHeld()).toBe(true);
    expect(await i.hold.read()).toEqual(legacy);
    expect(await resumeFree(i.deps, { reconciledBalanceUsd: 10, note: "legacy record" })).toMatchObject({ ok: true });
    expect(await i.store.get(LEGACY_HOLD_KEY)).toBeNull();
    expect(await i.hold.isHeld()).toBe(false);
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

/**
 * Concurrent settlement during resumption (V03). Judge requests keep running while
 * public inference is held, so a judge reservation can settle as a new overrun at
 * any point inside resumeFree. Each case runs that settlement inside one store
 * call that resumeFree makes after its inspection.
 */
describe("resumeFree with a concurrent hold event", () => {
  type Interleave = (i: ReturnType<typeof instance>) => Promise<void>;

  /** A store that runs `event` once, just before the first call that `matches`. */
  function interleaved(store: Store, matches: (op: string, key: string) => boolean, event: () => Promise<void>): Store & { fired: () => boolean } {
    let fired = false;
    const before = async (op: string, key: string) => {
      if (!fired && matches(op, key)) {
        fired = true;
        await event();
      }
    };
    return {
      ...store,
      fired: () => fired,
      async putIfAbsent(key, value, ttl) {
        await before("putIfAbsent", key);
        return store.putIfAbsent(key, value, ttl);
      },
      async delete(key) {
        await before("delete", key);
        return store.delete(key);
      },
      async compareAndSet(key, expected, next, ttl) {
        await before("compareAndSet", key);
        return store.compareAndSet(key, expected, next, ttl);
      },
    };
  }

  /** A judge request that settles above its reservation: a new overrun while the hold exists. */
  const judgeOverrun = async (i: ReturnType<typeof instance>, alert: OverrunAlert = async () => {}) => {
    const j = await i.ledger.reserve({ pool: "judge", sid: "judge", microUsd: 100 });
    if (!j.ok) throw new Error(`judge refused: ${j.reason}`);
    await recordOverrun(i.deps, await i.ledger.reconcile(j.reservationId, 1000), alert);
  };

  /** A judge request whose prompt tokens exceed the input bound, with no overrun. */
  const inputBoundBreach: Interleave = async (i) => {
    const j = await i.ledger.reserve({ pool: "judge", sid: "judge", microUsd: 1000 });
    if (!j.ok) throw new Error(`judge refused: ${j.reason}`);
    await recordOverrun(i.deps, await i.ledger.reconcile(j.reservationId, 900), async () => {}, { inputBoundExceeded: true });
  };

  const points: Array<[string, (op: string, key: string) => boolean]> = [
    ["while the audit record is written", (op, key) => op === "putIfAbsent" && key.startsWith(AUDIT_PREFIX)],
    ["just before the ledger flag is cleared", (op, key) => op === "compareAndSet" && key === LEDGER_KEY],
  ];

  async function heldWithInterleave(matches: (op: string, key: string) => boolean, event: Interleave) {
    const clock = fakeClock(START);
    const backing = createMemoryBacking();
    const i = instance(backing, clock);
    await overrun(i);
    const other = instance(backing, clock);
    const store = interleaved(i.store, matches, () => event(other));
    return { i, store, deps: { ...i.deps, store } };
  }

  for (const [when, matches] of points) {
    for (const [what, event] of [
      ["a judge overrun", (i: ReturnType<typeof instance>) => judgeOverrun(i)],
      ["an input-bound breach", inputBoundBreach],
    ] as const) {
      // Fails if resumption clears the flag or the record from a snapshot that a newer hold event made stale.
      it(`keeps the hold and refuses when ${what} happens ${when}`, async () => {
        const { i, store, deps } = await heldWithInterleave(matches, event);
        const r = await resumeFree(deps, { reconciledBalanceUsd: 10, note: "balance inspected before the concurrent settlement" });
        expect(store.fired()).toBe(true);
        expect(r).toMatchObject({ ok: false, reason: "hold_changed" });
        if (r.ok) return;
        expect(r.message).toMatch(/hold stays in place/i);
        expect(await i.hold.isHeld()).toBe(true);
        expect((await i.ledger.budgets()).held).toBe(true);
        expect(await i.hold.read()).not.toBeNull();
        expect(await i.ledger.reserve({ pool: "public", sid: "s", microUsd: 1 })).toEqual({ ok: false, reason: "hold" });
      });
    }
  }

  // Fails if the refused attempt leaves no audit evidence of the refusal.
  it("records the refused attempt in the audit trail", async () => {
    const { store, deps } = await heldWithInterleave(points[0]![1], (i) => judgeOverrun(i));
    const r = await resumeFree(deps, { reconciledBalanceUsd: 10, note: "first attempt" });
    expect(r).toMatchObject({ ok: false, reason: "hold_changed" });
    const attempt = await store.get<Record<string, unknown>>(`${AUDIT_PREFIX}${new Date(START).toISOString()}`);
    const refusal = await store.get<Record<string, unknown>>(`${AUDIT_PREFIX}${new Date(START).toISOString()}-1`);
    expect(attempt).toMatchObject({ action: "resume-free", note: "first attempt" });
    expect(refusal).toMatchObject({ action: "resume-free-refused", reason: "hold_changed", attempt: `${AUDIT_PREFIX}${new Date(START).toISOString()}` });
  });

  // Fails if unrelated ledger activity (a judge request settled within its reservation) blocks resumption.
  it("still resumes when only ordinary judge requests settle during resumption", async () => {
    const ordinary: Interleave = async (i) => {
      const j = await i.ledger.reserve({ pool: "judge", sid: "judge", microUsd: 1000 });
      if (!j.ok) throw new Error("judge refused");
      await recordOverrun(i.deps, await i.ledger.reconcile(j.reservationId, 900), async () => {});
    };
    const { i, store, deps } = await heldWithInterleave(points[1]![1], ordinary);
    const r = await resumeFree(deps, { reconciledBalanceUsd: 10, note: "ordinary traffic" });
    expect(store.fired()).toBe(true);
    expect(r).toMatchObject({ ok: true });
    expect(await i.hold.isHeld()).toBe(false);
  });

  // Fails if the balance check uses only the inspected snapshot when settlement raises the ledger's remaining credit before clearing.
  it("rechecks the balance against the ledger at the moment the hold is cleared", async () => {
    const clock = fakeClock(START);
    const backing = createMemoryBacking();
    const i = instance(backing, clock);
    await overrun(i);
    const j = await i.ledger.reserve({ pool: "judge", sid: "judge", microUsd: 2_000_000 });
    if (!j.ok) throw new Error("judge refused");
    // 7.2 USD remains at inspection; the judge request then settles at 0.1 USD, so 9.1 USD remains when clearing.
    const other = instance(backing, clock);
    const store = interleaved(i.store, points[1]![1], async () => void (await other.ledger.reconcile(j.reservationId, 100_000)));
    const r = await resumeFree({ ...i.deps, store }, { reconciledBalanceUsd: 7.5, note: "balance read before the settlement" });
    expect(store.fired()).toBe(true);
    expect(r).toMatchObject({ ok: false, reason: "balance_below_ledger" });
    expect(await i.hold.isHeld()).toBe(true);
    expect(await i.hold.read()).not.toBeNull();
  });

  // Fails if a store failure while clearing leaves the hold without its record.
  it("keeps the hold record when clearing the ledger flag fails", async () => {
    const clock = fakeClock(START);
    const i = instance(createMemoryBacking(), clock);
    await overrun(i);
    const failing: Store = {
      ...i.store,
      async compareAndSet() {
        throw new Error("store unavailable");
      },
    };
    await expect(resumeFree({ ...i.deps, store: failing }, { reconciledBalanceUsd: 10, note: "x" })).rejects.toThrow();
    expect(await i.hold.read()).toMatchObject({ reason: "reservation_overrun" });
    expect(await i.hold.isHeld()).toBe(true);
  });

  // Fails if a thrown store error leaves only the "resume-free" attempt in the audit trail, with no outcome.
  it("records a resume-free-failed audit record when the store fails while clearing", async () => {
    const i = instance(createMemoryBacking(), fakeClock(START));
    await overrun(i);
    const failing: Store = {
      ...i.store,
      async compareAndSet() {
        throw new Error("store unavailable");
      },
    };
    await expect(resumeFree({ ...i.deps, store: failing }, { reconciledBalanceUsd: 10, note: "x" })).rejects.toThrow();
    const stamp = new Date(START).toISOString();
    expect(await i.store.get(`${AUDIT_PREFIX}${stamp}`)).toMatchObject({ action: "resume-free", note: "x" });
    expect(await i.store.get(`${AUDIT_PREFIX}${stamp}-1`)).toMatchObject({
      action: "resume-free-failed",
      attempt: `${AUDIT_PREFIX}${stamp}`,
      error: expect.stringContaining("inference counters unavailable"),
    });
  });

  // Fails if resumption reports success while a hold record remains: here a judge overrun's hold write is
  // delayed past the inspection and lands while resumption runs (the review probe).
  it("never reports success while a hold record remains when a hold write is delayed past inspection", async () => {
    const clock = fakeClock(START);
    const backing = createMemoryBacking();
    const i = instance(backing, clock);
    await overrun(i);
    clock.advance(1000);
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const judgeBase = createMemoryStore({ clock: clock.now, backing });
    const judgeStore: Store = {
      ...judgeBase,
      // Any write by the judge instance other than the ledger compare-and-set waits for the gate.
      async putIfAbsent(key, value, ttl) {
        if (key !== LEDGER_KEY) await gate;
        return judgeBase.putIfAbsent(key, value, ttl);
      },
    };
    const judgeDeps = { store: judgeStore, config: free, clock: clock.now };
    const judgeLedger = createLedger(judgeDeps);
    const j = await judgeLedger.reserve({ pool: "judge", sid: "j", microUsd: 100 });
    if (!j.ok) throw new Error("judge refused");
    const alert = vi.fn(async () => {});
    const judgeDone = (async () => recordOverrun(judgeDeps, await judgeLedger.reconcile(j.reservationId, 1000), alert))();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const store = interleaved(createMemoryStore({ clock: clock.now, backing }), (op, key) => op === "compareAndSet" && key === LEDGER_KEY, async () => {
      release();
      await judgeDone;
    });
    const r = await resumeFree({ ...i.deps, store }, { reconciledBalanceUsd: 10, note: "probe" });
    release();
    await judgeDone;
    const record = await i.hold.read();
    const held = await i.hold.isHeld();
    if (r.ok) {
      expect(record).toBeNull();
      expect(held).toBe(false);
    } else {
      expect(r.reason).toBe("hold_changed");
      expect(record).not.toBeNull();
      expect(held).toBe(true);
      expect((await i.ledger.budgets()).held).toBe(true);
    }
  });

  // Fails if a second resumption that inspected the same hold erases a newer hold written after the first one succeeded.
  it("a second concurrent resumption refuses and keeps the newer hold record", async () => {
    const clock = fakeClock(START);
    const backing = createMemoryBacking();
    const i = instance(backing, clock);
    await overrun(i);
    const a = instance(backing, clock);
    const alert = vi.fn(async () => {});
    let firstResult: unknown;
    // B inspects first; before B's first change to the hold, A resumes and a new judge overrun holds again.
    const storeB = interleaved(i.store, (op) => op === "delete" || op === "compareAndSet", async () => {
      firstResult = await resumeFree(a.deps, { reconciledBalanceUsd: 10, note: "A" });
      clock.advance(1000);
      await judgeOverrun(a, alert);
    });
    const b = await resumeFree({ ...i.deps, store: storeB }, { reconciledBalanceUsd: 10, note: "B" });
    expect(storeB.fired()).toBe(true);
    expect(firstResult).toMatchObject({ ok: true });
    expect(alert).toHaveBeenCalledTimes(1);
    expect(b).toMatchObject({ ok: false, reason: "hold_changed" });
    expect((await i.hold.read())?.at).toBe(new Date(START + 1000).toISOString());
    expect(await i.hold.isHeld()).toBe(true);
    expect((await i.ledger.budgets()).held).toBe(true);
  });

  // Fails if a resumed pool cannot be held again, or a second hold cannot be resumed with its own audit record.
  it("supports repeated holds and resumptions", async () => {
    const clock = fakeClock(START);
    const i = instance(createMemoryBacking(), clock);
    await overrun(i);
    const first = await resumeFree(i.deps, { reconciledBalanceUsd: 10, note: "first" });
    expect(first).toMatchObject({ ok: true });
    expect(await i.hold.isHeld()).toBe(false);

    clock.advance(DAY);
    const alert = vi.fn(async () => {});
    await judgeOverrun(i, alert);
    expect(alert).toHaveBeenCalledTimes(1);
    expect(await i.hold.isHeld()).toBe(true);
    expect((await i.hold.read())?.at).toBe(new Date(START + DAY).toISOString());

    clock.advance(60_000);
    const second = await resumeFree(i.deps, { reconciledBalanceUsd: 10, note: "second" });
    expect(second).toMatchObject({ ok: true });
    if (!first.ok || !second.ok) return;
    expect(second.auditKey).not.toBe(first.auditKey);
    expect(await i.store.get(second.auditKey)).toMatchObject({ note: "second", hold: { at: new Date(START + DAY).toISOString() } });
    expect(await i.hold.isHeld()).toBe(false);
  });

  // Fails if an overrun after a completed resumption is lost (no hold, no record or no alert).
  it("holds again for an overrun that settles after resumption completes", async () => {
    const i = instance(createMemoryBacking(), fakeClock(START));
    await overrun(i);
    expect(await resumeFree(i.deps, { reconciledBalanceUsd: 10, note: "done" })).toMatchObject({ ok: true });
    const alert = vi.fn(async () => {});
    await judgeOverrun(i, alert);
    expect(alert).toHaveBeenCalledTimes(1);
    expect(await i.hold.read()).toMatchObject({ reason: "reservation_overrun", overrunMicroUsd: 900 });
    expect((await i.ledger.budgets()).held).toBe(true);
  });
});
