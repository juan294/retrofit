import { spawnSync } from "node:child_process";
import net from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";
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

  // Fails if a store or configuration failure is reported as a refusal, or a factory error crashes the CLI.
  it("exits 2 when the target cannot be built and 3 when the store fails", async () => {
    const h = await heldHooks();
    expect(await run(["--reconciled-balance", "9.2", "--note", "x"], async () => Promise.reject(new Error("SUPABASE_URL is not set")))).toBe(2);
    const err: string[] = [];
    const failing = { ...h.hooks, err: (s: string) => err.push(s), inspect: () => Promise.reject(new Error("store get failed (request_failed)")) };
    expect(await run(["--reconciled-balance", "9.2", "--note", "x"], failing)).toBe(3);
    expect(err.join("\n")).toMatch(/store get failed/);
    expect(await h.hold.isHeld()).toBe(true);
  });

  // Fails if `pnpm ops:resume-free -- --reconciled-balance ...` (pnpm passes the "--" through) is refused.
  it("ignores a leading -- separator", async () => {
    const h = await heldHooks();
    expect(await run(["--", "--reconciled-balance", "9.2", "--note", "Reconciled"], h.hooks)).toBe(0);
    expect(await h.hold.isHeld()).toBe(false);
    expect(await run(["--reconciled-balance", "9.2", "--", "--note", "x"], h.hooks)).toBe(1);
  });

  // Fails if the owner cannot see which settings are defaults before any change.
  it("prints the effective settings, marking defaults, before the state", async () => {
    const h = await heldHooks();
    const settings: Array<{ name: string; value: string; source: "set" | "default" }> = [
      { name: "FREE_CREDIT_USD", value: "10", source: "set" },
      { name: "FREE_MAX_TOKENS", value: "1024", source: "default" },
    ];
    expect(await run(["--reconciled-balance", "9.1", "--note", "x"], { ...h.hooks, settings })).toBe(1);
    const printed = h.out.join("\n");
    expect(printed).toMatch(/FREE_CREDIT_USD=10 \(set\)/);
    expect(printed).toMatch(/FREE_MAX_TOKENS=1024 \(default\)/);
    expect(printed.indexOf("FREE_MAX_TOKENS")).toBeLessThan(printed.indexOf("Ledger spent"));
  });

  // Fails if a cleared ledger hold whose legacy record could not be deleted is reported as a plain success or as nothing resumed.
  it("exits 4 when the hold was cleared but the legacy record could not be deleted", async () => {
    const h = await heldHooks();
    const partial = { ...h.hooks, resume: async () => ({ ok: true, auditKey: "inference:audit:t", legacyDeleteError: "store unavailable" }) };
    expect(await run(["--reconciled-balance", "9.2", "--note", "x"], partial)).toBe(4);
    expect(h.out.join("\n")).toMatch(/Ledger hold cleared\. Audit record: inference:audit:t/);
    expect(h.err.join("\n")).toMatch(/legacy hold record inference:hold could not be deleted \(store unavailable\)/);
    expect(h.err.join("\n")).toMatch(/still closes the public pool; rerun/);
  });

  // Fails if the CLI reports success for a hold_changed refusal.
  it("exits 1 with the refusal text when a hold event races the resumption", async () => {
    const h = await heldHooks();
    const racing = { ...h.hooks, resume: async () => ({ ok: false, reason: "hold_changed", message: "the hold stays in place" }) };
    expect(await run(["--reconciled-balance", "9.2", "--note", "x"], racing)).toBe(1);
    expect(h.err.join("\n")).toMatch(/Refused: the hold stays in place/);
  });
});

/** The real executable: `pnpm ops:resume-free` runs exactly this file with Node. */
describe("resume-free executable", () => {
  const exec = (args: string[], env: Record<string, string>) =>
    spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env: { NODE_ENV: "test", PATH: process.env.PATH ?? "", ...env } });

  const FREE_ENV = { FREE_CREDIT_USD: "10", JUDGE_RESERVE_USD: "3", FREE_PRICE_IN_PER_M: "0.1", FREE_PRICE_OUT_PER_M: "0.4", FREE_SERVICE_END: "2027-01-18T23:59:59Z" };

  /** A loopback port with nothing listening on it. */
  async function closedPort(): Promise<number> {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as net.AddressInfo;
    await new Promise((resolve) => server.close(resolve));
    return port;
  }

  // Fails if the executable checks the store before the owner's authorization inputs.
  it("refuses missing authorization inputs before it builds a store", () => {
    const r = exec(["--note", "checked"], {});
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/--reconciled-balance/);
  });

  // Fails if the executable runs without a configured store or the deployment's ledger amounts.
  it("exits 2 naming the missing store configuration", () => {
    const r = exec(["--reconciled-balance", "9.2", "--note", "x"], FREE_ENV);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/SUPABASE_URL/);
    const noAmounts = exec(["--reconciled-balance", "9.2", "--note", "x"], { SUPABASE_URL: "http://127.0.0.1:1", SUPABASE_SERVICE_ROLE_KEY: "k" });
    expect(noAmounts.status).toBe(2);
    expect(noAmounts.stderr).toMatch(/FREE_CREDIT_USD/);
  });

  // Fails if the executable cannot load the TypeScript store adapter, or leaks the key when the store is unreachable.
  it("builds the Supabase adapter and exits 3 when the store is unreachable", async () => {
    const port = await closedPort();
    const key = "service-role-key-that-must-not-print";
    const r = exec(["--reconciled-balance", "9.2", "--note", "x"], { ...FREE_ENV, SUPABASE_URL: `http://127.0.0.1:${port}`, SUPABASE_SERVICE_ROLE_KEY: key });
    expect(r.stdout).toContain(`Store: http://127.0.0.1:${port}`);
    expect(r.stdout).toMatch(/FREE_SERVICE_END=2027-01-18T23:59:59\.000Z \(set\)/);
    expect(r.stdout).toMatch(/FREE_MAX_TOKENS=1024 \(default\)/);
    expect(r.status).toBe(3);
    expect(r.stderr).toMatch(/Store error: inference counters unavailable/);
    expect(r.stdout + r.stderr).not.toContain(key);
  });
});

describe("source hooks", () => {
  const hooks = fileURLToPath(new URL("../../tools/ops/source-hooks.mjs", import.meta.url));

  // Fails if loading TypeScript through the hooks prints Node's ExperimentalWarning, or if other warnings are hidden.
  it("loads a TypeScript module without the stripTypeScriptTypes warning and keeps other warnings", () => {
    const code = `const m = await import(${JSON.stringify(pathToFileURL(hooks).href)}); m.registerSourceHooks();
const e = await import(m.sourceUrl("lib/inference/errors.ts")); console.log(typeof e.CountersUnavailable);
process.emitWarning("other warning stays visible");`;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("function");
    expect(r.stderr).not.toMatch(/stripTypeScriptTypes is an experimental feature/);
    expect(r.stderr).toMatch(/other warning stays visible/);
  });
});
