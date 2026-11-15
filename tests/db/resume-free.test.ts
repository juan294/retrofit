/**
 * `pnpm ops:resume-free` end to end: the real executable (tools/ops/resume-free.mjs)
 * against the disposable Supabase stack that `pnpm test:db` starts, with a hold
 * written through the real ledger over the Supabase adapter. The target is always
 * the gate stack on a loopback address; this file refuses any other URL.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadFreeConfig } from "@/lib/config";
import { AUDIT_PREFIX, HOLD_KEY, createHold, recordOverrun, resumeFree } from "@/lib/inference/hold";
import { LEDGER_KEY, createLedger } from "@/lib/inference/ledger";
import { createSupabaseStore } from "@/lib/store/supabase";
import { type Store, systemClock } from "@/lib/store/types";

const url = process.env.SUPABASE_GATE_URL;
const serviceRoleKey = process.env.SUPABASE_GATE_SERVICE_ROLE_KEY;
if (!url || !serviceRoleKey) {
  throw new Error(
    "tests/db/resume-free.test.ts needs SUPABASE_GATE_URL and SUPABASE_GATE_SERVICE_ROLE_KEY from a disposable Supabase stack with the store migration applied. Run it through pnpm test:db.",
  );
}
if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname)) {
  throw new Error(`tests/db/resume-free.test.ts runs only against a loopback gate stack, not ${new URL(url).origin}`);
}

vi.setConfig({ testTimeout: 30_000 });

const script = fileURLToPath(new URL("../../tools/ops/resume-free.mjs", import.meta.url));
const FREE_ENV = {
  FREE_CREDIT_USD: "10",
  JUDGE_RESERVE_USD: "3",
  FREE_PRICE_IN_PER_M: "0.1",
  FREE_PRICE_OUT_PER_M: "0.4",
  FREE_SERVICE_END: "2027-01-18T23:59:59Z",
};
const TARGET_ENV = { ...FREE_ENV, SUPABASE_URL: url, SUPABASE_SERVICE_ROLE_KEY: serviceRoleKey };
const free = loadFreeConfig(FREE_ENV, false);

const store = createSupabaseStore({ url, serviceRoleKey });
const deps = { store, config: free, clock: systemClock };
const auditKeys: string[] = [];

/** Runs the real executable with only the given environment (and PATH). */
function exec(args: string[], env: Record<string, string>): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { env: { NODE_ENV: "test", PATH: process.env.PATH ?? "", ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

/** A judge request reported above its reservation: an overrun that writes the hold. */
async function judgeOverrun(on: { store: Store } = deps, alert = async () => {}) {
  const d = { ...deps, store: on.store };
  const ledger = createLedger(d);
  const r = await ledger.reserve({ pool: "judge", sid: "db-judge", microUsd: 1000 });
  if (!r.ok) throw new Error(`judge refused: ${r.reason}`);
  await recordOverrun(d, await ledger.reconcile(r.reservationId, 5000), alert);
}

beforeEach(async () => {
  // These keys are fixed by the application, so this file owns them on the gate stack.
  await store.delete(LEDGER_KEY);
  await store.delete(HOLD_KEY);
});

afterAll(async () => {
  for (const key of auditKeys) await store.delete(key);
  await store.delete(LEDGER_KEY);
  await store.delete(HOLD_KEY);
});

describe("ops:resume-free against the gate store", () => {
  // Fails if the executable cannot reach the Supabase adapter, skips the audit record, or leaves the hold.
  it("removes a real hold and writes the audit record", async () => {
    await judgeOverrun();
    const hold = createHold(deps);
    expect(await hold.isHeld()).toBe(true);
    const remaining = (await createLedger(deps).budgets()).remainingCreditMicro;

    const r = await exec(["--reconciled-balance", (remaining / 1_000_000).toFixed(6), "--note", "gate-stack reconciliation"], TARGET_ENV);
    expect(r.stderr).not.toContain(serviceRoleKey);
    expect(r.stdout).not.toContain(serviceRoleKey);
    expect(r.stdout).toContain(`Store: ${new URL(url).origin}`);
    expect(r.stdout).toMatch(/Hold: \{.*"reason":"reservation_overrun"/);
    expect(r.status).toBe(0);
    const auditKey = /Audit record: (\S+)/.exec(r.stdout)?.[1];
    expect(auditKey?.startsWith(AUDIT_PREFIX)).toBe(true);
    auditKeys.push(auditKey!);

    expect(await store.get(auditKey!)).toMatchObject({
      action: "resume-free",
      note: "gate-stack reconciliation",
      reconciledBalanceMicroUsd: remaining,
      ledgerRemainingMicroUsd: remaining,
      totalSpentMicroUsd: 5000,
      hold: { reason: "reservation_overrun", overrunMicroUsd: 4000 },
    });
    expect(await hold.isHeld()).toBe(false);
    expect(await hold.read()).toBeNull();

    // A second run finds no hold to remove.
    const again = await exec(["--reconciled-balance", "10", "--note", "again"], TARGET_ENV);
    expect(again.status).toBe(1);
    expect(again.stderr).toMatch(/There is no hold to remove/);
  });

  // Fails if the executable acts without the owner's balance, note or the target configuration.
  it("refuses without authorization inputs or configuration and keeps the hold", async () => {
    await judgeOverrun();
    const noBalance = await exec(["--note", "checked"], TARGET_ENV);
    expect(noBalance.status).toBe(1);
    expect(noBalance.stderr).toMatch(/--reconciled-balance/);
    const noNote = await exec(["--reconciled-balance", "10"], TARGET_ENV);
    expect(noNote.status).toBe(1);
    expect(noNote.stderr).toMatch(/--note/);
    const noStore = await exec(["--reconciled-balance", "10", "--note", "x"], FREE_ENV);
    expect(noStore.status).toBe(2);
    expect(noStore.stderr).toMatch(/SUPABASE_URL/);
    const noAmounts = await exec(["--reconciled-balance", "10", "--note", "x"], { SUPABASE_URL: url, SUPABASE_SERVICE_ROLE_KEY: serviceRoleKey });
    expect(noAmounts.status).toBe(2);
    expect(noAmounts.stderr).toMatch(/FREE_CREDIT_USD/);

    const below = await exec(["--reconciled-balance", "1", "--note", "too low"], TARGET_ENV);
    expect(below.status).toBe(1);
    expect(below.stderr).toMatch(/below the ledger's remaining credit/);
    expect(await createHold(deps).isHeld()).toBe(true);
    expect(await createHold(deps).read()).not.toBeNull();
  });

  // Fails if a judge overrun from another instance during resumption is erased on the Supabase adapter (V03).
  it("keeps the hold when another instance records an overrun during resumption", async () => {
    await judgeOverrun();
    const other = createSupabaseStore({ url, serviceRoleKey });
    let fired = false;
    const racing: Store = {
      ...store,
      async putIfAbsent(key, value, ttl) {
        if (!fired && key.startsWith(AUDIT_PREFIX)) {
          fired = true;
          await judgeOverrun({ store: other });
        }
        const r = await store.putIfAbsent(key, value, ttl);
        if (r.created) auditKeys.push(key);
        return r;
      },
    };
    const r = await resumeFree({ ...deps, store: racing }, { reconciledBalanceUsd: 10, note: "race" });
    expect(fired).toBe(true);
    expect(r).toMatchObject({ ok: false, reason: "hold_changed" });
    expect(await createHold(deps).isHeld()).toBe(true);
    expect((await createLedger(deps).budgets()).held).toBe(true);
    expect(await createHold(deps).read()).toMatchObject({ reason: "reservation_overrun" });
  });
});
