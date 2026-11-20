import { describe, expect, it } from "vitest";
import { type FreeConfig, loadFreeConfig } from "@/lib/config";
import { CountersUnavailable } from "@/lib/inference/errors";
import { createLedger, daysLeft } from "@/lib/inference/ledger";
import { createMemoryBacking, createMemoryStore } from "@/lib/store/memory";
import type { Store } from "@/lib/store/types";
import { fakeClock } from "../helpers/server-deps";
import { jitter } from "../helpers/jitter-store";

const DAY = 86_400_000;
// Credit 10 USD, reserve 3 USD: 7 USD public over 10 UTC days (2026-11-15 to 2026-11-24) is 0.7 USD a day.
const free: FreeConfig = loadFreeConfig({ FREE_CREDIT_USD: "10", JUDGE_RESERVE_USD: "3", FREE_SERVICE_END: "2026-11-24T23:59:59Z" }, false);
const START = Date.parse("2026-11-15T12:00:00Z");
const DAILY = 700_000;

function setup(store?: Store) {
  const clock = fakeClock(START);
  const s = store ?? createMemoryStore({ clock: clock.now });
  return { clock, store: s, ledger: createLedger({ store: s, config: free, clock: clock.now }) };
}

async function okReservation(p: Promise<{ ok: boolean; reservationId?: string }>): Promise<string> {
  const r = await p;
  expect(r).toMatchObject({ ok: true });
  return r.reservationId!;
}

describe("daysLeft", () => {
  // Fails if the count of UTC days to the service end is off by one at either edge.
  it("counts today and the end day", () => {
    const end = Date.parse("2026-11-24T23:59:59Z");
    expect(daysLeft(end, Date.parse("2026-11-15T00:00:00Z"))).toBe(10);
    expect(daysLeft(end, Date.parse("2026-11-24T23:00:00Z"))).toBe(1);
    expect(daysLeft(end, Date.parse("2026-12-01T00:00:00Z"))).toBe(1);
  });
});

describe("ledger", () => {
  // Fails if the public daily budget is not (credit - reserve - spent - outstanding) / daysLeft, stored per UTC day.
  it("applies the public daily budget formula across days", async () => {
    const { clock, ledger } = setup();
    expect((await ledger.budgets()).publicDailyMicro).toBe(DAILY);
    const id = await okReservation(ledger.reserve({ pool: "public", sid: "s1", microUsd: 400_000 }));
    await ledger.reconcile(id, 400_000);
    expect(await ledger.reserve({ pool: "public", sid: "s1", microUsd: 300_001 })).toEqual({ ok: false, reason: "public_pool" });
    await okReservation(ledger.reserve({ pool: "public", sid: "s1", microUsd: 300_000 }));
    let b = await ledger.budgets();
    expect(b.publicSpentTodayMicro).toBe(400_000);
    expect(b.totalOutstandingMicro).toBe(300_000);

    // Next UTC day, 9 days left. The 300 000 reservation counts whether still outstanding or settled in full as stale.
    clock.set(Date.parse("2026-11-16T00:00:01Z"));
    b = await ledger.budgets();
    expect(b.publicDailyMicro).toBe(Math.floor((7_000_000 - 400_000 - 300_000) / 9));
    expect(b.publicSpentTodayMicro).toBe(0);

    // The budget is fixed for the day: spending later the same day does not recompute it.
    const id2 = await okReservation(ledger.reserve({ pool: "public", sid: "s2", microUsd: 100_000 }));
    await ledger.reconcile(id2, 100_000);
    clock.advance(3_600_000);
    b = await ledger.budgets();
    expect(b.publicDailyMicro).toBe(700_000);
    expect(b.publicSpentTodayMicro).toBe(100_000);
  });

  // Fails if public spend (within its cap) can lower the judge reserve.
  it("public spend cannot reduce the judge budget", async () => {
    const { clock, ledger } = setup();
    for (let day = 0; day < 10; day++) {
      clock.set(START + day * DAY);
      const daily = (await ledger.budgets()).publicDailyMicro;
      expect(daily).toBe(DAILY);
      const id = await okReservation(ledger.reserve({ pool: "public", sid: `s${day}`, microUsd: daily }));
      await ledger.reconcile(id, daily);
      expect(await ledger.reserve({ pool: "public", sid: `s${day}`, microUsd: 1 })).toEqual({ ok: false, reason: "public_pool" });
    }
    const b = await ledger.budgets();
    expect(b.totalSpentMicro).toBe(7_000_000);
    expect(b.judgeRemainingMicro).toBe(3_000_000);
    await okReservation(ledger.reserve({ pool: "judge", sid: "j", microUsd: 3_000_000 }));
  });

  // Fails if reconciliation keeps the whole reservation when usage is lower.
  it("reconciliation lowers a reservation to the reported usage", async () => {
    const { ledger } = setup();
    const id = await okReservation(ledger.reserve({ pool: "public", sid: "s", microUsd: 700_000 }));
    expect(await ledger.reconcile(id, 100_000)).toMatchObject({ found: true, overrun: false, chargedMicroUsd: 100_000 });
    const b = await ledger.budgets();
    expect(b.totalSpentMicro).toBe(100_000);
    expect(b.totalOutstandingMicro).toBe(0);
    await okReservation(ledger.reserve({ pool: "public", sid: "s", microUsd: 600_000 }));
  });

  // Fails if missing usage releases any part of the reservation.
  it("missing usage keeps the full reservation as spent", async () => {
    const { ledger } = setup();
    const id = await okReservation(ledger.reserve({ pool: "judge", sid: "j", microUsd: 250_000 }));
    expect(await ledger.reconcile(id, null)).toMatchObject({ overrun: false, chargedMicroUsd: 250_000 });
    const b = await ledger.budgets();
    expect(b.totalSpentMicro).toBe(250_000);
    expect(b.judgeRemainingMicro).toBe(2_750_000);
  });

  // Fails if a second reconcile of one reservation charges twice.
  it("reconciles a reservation once", async () => {
    const { ledger } = setup();
    const id = await okReservation(ledger.reserve({ pool: "public", sid: "s", microUsd: 1000 }));
    await ledger.reconcile(id, 500);
    expect(await ledger.reconcile(id, 500)).toMatchObject({ found: false, chargedMicroUsd: 0 });
    expect((await ledger.budgets()).totalSpentMicro).toBe(500);
  });

  // Fails if outstanding reservations are not counted against the public day and the judge budget.
  it("outstanding reservations reduce both budgets", async () => {
    const { ledger } = setup();
    await okReservation(ledger.reserve({ pool: "public", sid: "s", microUsd: 400_000 }));
    expect(await ledger.reserve({ pool: "public", sid: "s", microUsd: 400_000 })).toEqual({ ok: false, reason: "public_pool" });
    await okReservation(ledger.reserve({ pool: "judge", sid: "j", microUsd: 2_000_000 }));
    expect((await ledger.budgets()).judgeRemainingMicro).toBe(1_000_000);
    expect(await ledger.reserve({ pool: "judge", sid: "j", microUsd: 1_000_001 })).toEqual({ ok: false, reason: "judge_pool" });
    await okReservation(ledger.reserve({ pool: "judge", sid: "j", microUsd: 1_000_000 }));
  });

  // Fails if an overrun is recorded below the reported usage, or the judge budget ignores it.
  it("after an overrun, the judge budget equals the remaining credit when that is lower than the reserve", async () => {
    const { ledger } = setup();
    const id = await okReservation(ledger.reserve({ pool: "public", sid: "s", microUsd: 700_000 }));
    expect(await ledger.reconcile(id, 7_500_000)).toEqual({
      found: true,
      overrun: true,
      chargedMicroUsd: 7_500_000,
      reservationMicroUsd: 700_000,
      overrunMicroUsd: 6_800_000,
      holdCreated: true,
    });
    const b = await ledger.budgets();
    expect(b.totalSpentMicro).toBe(7_500_000);
    expect(b.judgeRemainingMicro).toBe(2_500_000);
    expect(await ledger.reserve({ pool: "judge", sid: "j", microUsd: 2_500_001 })).toEqual({ ok: false, reason: "ledger" });
    await okReservation(ledger.reserve({ pool: "judge", sid: "j", microUsd: 2_500_000 }));
    // The overrun closes the public pool in the same atomic write.
    expect(await ledger.reserve({ pool: "public", sid: "s", microUsd: 1 })).toEqual({ ok: false, reason: "hold" });
  });

  // Fails if reserve is not atomic: two parallel requests when only one fits must give one refusal.
  it("gives one refusal for two parallel requests when only one reservation fits", async () => {
    for (let round = 0; round < 20; round++) {
      const clock = fakeClock(START);
      const backing = createMemoryBacking();
      const a = createLedger({ store: jitter(createMemoryStore({ clock: clock.now, backing })), config: free, clock: clock.now });
      const b = createLedger({ store: jitter(createMemoryStore({ clock: clock.now, backing })), config: free, clock: clock.now });
      const results = await Promise.all([
        a.reserve({ pool: "public", sid: "s1", microUsd: 400_000 }),
        b.reserve({ pool: "public", sid: "s2", microUsd: 400_000 }),
      ]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, reason: "public_pool" }]);
      expect((await a.budgets()).totalOutstandingMicro).toBe(400_000);
    }
  });

  // Fails if concurrent reservations lose updates (more admitted than the budget holds).
  it("admits exactly what fits under 16 concurrent reservations", async () => {
    const clock = fakeClock(START);
    const backing = createMemoryBacking();
    const ledgers = [0, 1].map(() => createLedger({ store: jitter(createMemoryStore({ clock: clock.now, backing })), config: free, clock: clock.now }));
    const results = await Promise.all(
      Array.from({ length: 16 }, (_, i) => ledgers[i % 2]!.reserve({ pool: "public", sid: `s${i}`, microUsd: 100_000 })),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(7);
    expect((await ledgers[0]!.budgets()).totalOutstandingMicro).toBe(700_000);
  });

  // Fails if a reservation that was never reconciled (crashed request) is forgotten instead of charged in full.
  it("charges an abandoned reservation in full after it goes stale", async () => {
    const { clock, ledger } = setup();
    await okReservation(ledger.reserve({ pool: "public", sid: "s", microUsd: 300_000 }));
    clock.advance(11 * 60_000);
    const b = await ledger.budgets();
    expect(b.totalOutstandingMicro).toBe(0);
    expect(b.totalSpentMicro).toBe(300_000);
    expect(b.publicSpentTodayMicro).toBe(300_000);
  });

  // Fails if invalid amounts are accepted.
  it("rejects a non-integer or non-positive reservation", async () => {
    const { ledger } = setup();
    await expect(ledger.reserve({ pool: "public", sid: "s", microUsd: 1.5 })).rejects.toThrow(RangeError);
    await expect(ledger.reserve({ pool: "public", sid: "s", microUsd: 0 })).rejects.toThrow(RangeError);
  });

  // Fails if a store failure surfaces as anything but CountersUnavailable (the proxy maps it to 503).
  it("throws CountersUnavailable when the store fails", async () => {
    const broken = new Proxy(createMemoryStore(), {
      get: () => async () => {
        throw new Error("connection refused");
      },
    });
    const { ledger } = setup(broken);
    await expect(ledger.reserve({ pool: "public", sid: "s", microUsd: 1 })).rejects.toBeInstanceOf(CountersUnavailable);
    await expect(ledger.reconcile("r", 1)).rejects.toBeInstanceOf(CountersUnavailable);
    await expect(ledger.budgets()).rejects.toBeInstanceOf(CountersUnavailable);
  });

  // Fails if endless compare-and-set conflicts loop forever instead of failing as unavailable.
  it("throws CountersUnavailable after bounded compare-and-set retries", async () => {
    const real = createMemoryStore();
    const conflicting = new Proxy(real, {
      get: (target, prop, receiver) => (prop === "compareAndSet" ? async () => false : Reflect.get(target, prop, receiver)),
    });
    const { ledger } = setup(conflicting);
    await expect(ledger.reserve({ pool: "public", sid: "s", microUsd: 1 })).rejects.toBeInstanceOf(CountersUnavailable);
  });
});
