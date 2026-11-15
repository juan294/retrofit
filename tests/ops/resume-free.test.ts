import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadFreeConfig } from "@/lib/config";
import { createHold, describeFreeState, recordOverrun, resumeFree } from "@/lib/inference/hold";
import { createLedger } from "@/lib/inference/ledger";
import { createMemoryStore } from "@/lib/store/memory";
import { fakeClock } from "../helpers/server-deps";
import { main } from "../../tools/ops/resume-free.mjs";

const script = fileURLToPath(new URL("../../tools/ops/resume-free.mjs", import.meta.url));
const free = loadFreeConfig({ FREE_CREDIT_USD: "10", JUDGE_RESERVE_USD: "3", FREE_SERVICE_END: "2026-11-24T23:59:59Z" }, false);

const run = main;

async function heldHooks() {
  const clock = fakeClock(Date.parse("2026-11-15T12:00:00Z"));
  const store = createMemoryStore({ clock: clock.now });
  const deps = { store, config: free, clock: clock.now };
  const ledger = createLedger(deps);
  const r = await ledger.reserve({ pool: "public", sid: "s", microUsd: 700_000 });
  if (!r.ok) throw new Error("refused");
  await recordOverrun(deps, await ledger.reconcile(r.reservationId, 800_000), async () => {});
  const out: string[] = [];
  const err: string[] = [];
  const hooks = {
    inspect: () => describeFreeState(deps),
    resume: (input: { reconciledBalanceUsd: number; note: string }) => resumeFree(deps, input),
    out: (s: string) => out.push(s),
    err: (s: string) => err.push(s),
  };
  return { hooks, out, err, hold: createHold(deps) };
}

describe("resume-free CLI", () => {
  // Fails if the CLI touches the store or succeeds without the owner's balance.
  it("refuses without --reconciled-balance", async () => {
    const h = await heldHooks();
    expect(await run(["--note", "checked"], h.hooks)).toBe(1);
    expect(h.err.join("\n")).toMatch(/--reconciled-balance/);
    expect(await h.hold.isHeld()).toBe(true);
  });

  // Fails if a non-numeric balance or a missing note is accepted.
  it("refuses a malformed balance and a missing note", async () => {
    const h = await heldHooks();
    expect(await run(["--reconciled-balance", "lots", "--note", "x"], h.hooks)).toBe(1);
    expect(await run(["--reconciled-balance", "9.2"], h.hooks)).toBe(1);
    expect(await run(["--reconciled-balance", "9.2", "--note", "x", "--force"], h.hooks)).toBe(1);
    expect(await h.hold.isHeld()).toBe(true);
  });

  // Fails if the CLI resumes when the entered balance is below the ledger's remaining credit.
  it("refuses a balance below the ledger's remaining credit and prints the state", async () => {
    const h = await heldHooks();
    expect(await run(["--reconciled-balance", "9.1", "--note", "x"], h.hooks)).toBe(1);
    const printed = h.out.join("\n");
    expect(printed).toMatch(/Ledger spent: 0\.800000 USD/);
    expect(printed).toMatch(/Outstanding reservations: 0\.000000 USD/);
    expect(printed).toMatch(/reservation_overrun/);
    expect(printed).toMatch(/framingTokensBase/);
    expect(h.err.join("\n")).toMatch(/below the ledger's remaining credit/);
    expect(await h.hold.isHeld()).toBe(true);
  });

  // Fails if a valid resume does not remove the hold or report the audit record.
  it("removes the hold with a valid balance and reports the audit key", async () => {
    const h = await heldHooks();
    expect(await run(["--reconciled-balance", "9.2", "--note", "Reconciled on Otari"], h.hooks)).toBe(0);
    expect(h.out.join("\n")).toMatch(/inference:audit:2026-11-15T12:00:00\.000Z/);
    expect(await h.hold.isHeld()).toBe(false);
  });

  // Fails if the real CLI runs against anything before Phase 7 configures a production store.
  it("exits 2 without a test hook", () => {
    const r = spawnSync(process.execPath, [script, "--reconciled-balance", "9.2", "--note", "x"], { encoding: "utf8" });
    expect(r.status).toBe(2);
    expect(r.stdout + r.stderr).toContain("No production store configured until Phase 7");
  });
});
