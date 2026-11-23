/**
 * The Supabase AccountData adapter pointed at a closed port fails closed, logs
 * [TABLE_FALLBACK] at ERROR, and never logs an email address, token or the
 * service role key. No database is needed; this file is a listed exception in
 * eslint-rules/no-supabase-in-tests.mjs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountDataUnavailable, type AccountData } from "@/lib/accounts/data";
import { createSupabaseAccountData } from "@/lib/accounts/supabase";
import { loadConfig } from "@/lib/config";
import { getAccountData } from "@/lib/server/runtime";

const CLOSED = "http://127.0.0.1:1";
const SERVICE_KEY = "service-role-test-secret";
const EMAIL = "secret.person@example.test";
const HASH = "a".repeat(64);
const closed = () => createSupabaseAccountData({ url: CLOSED, serviceRoleKey: SERVICE_KEY, timeoutMs: 2000 });

let errorLog: ReturnType<typeof vi.spyOn>;
const logged = (): string[] => errorLog.mock.calls.map((args: unknown[]) => args.map(String).join(" "));

beforeEach(() => {
  errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  errorLog.mockRestore();
});

describe("Supabase AccountData on a closed port", () => {
  const ops: Array<[string, (d: AccountData) => Promise<unknown>]> = [
    ["addNotifySignup", (d) => d.addNotifySignup(EMAIL, true)],
    ["findNotifySignup", (d) => d.findNotifySignup(EMAIL)],
    ["unsubscribe", (d) => d.unsubscribe(HASH)],
  ];

  // Fails if a failed call resolves (a fallback) instead of throwing, is logged below ERROR or without
  // [TABLE_FALLBACK], or the log line carries the address, the hash or the service role key.
  it.each(ops)("%s throws AccountDataUnavailable and logs [TABLE_FALLBACK] without personal data", async (op, run) => {
    await expect(run(closed())).rejects.toBeInstanceOf(AccountDataUnavailable);
    const lines = logged();
    expect(lines.length).toBeGreaterThanOrEqual(1);
    expect(lines[0]).toContain(`[TABLE_FALLBACK] accounts ${op} failed`);
    for (const line of lines) for (const secret of [EMAIL, "secret.person", HASH, SERVICE_KEY]) expect(line).not.toContain(secret);
  });

  // Fails if argument checks need the network (an invalid address would be reported as an outage).
  it("refuses an invalid address with RangeError, answers unknown for a malformed hash, and logs nothing", async () => {
    const d = closed();
    await expect(d.addNotifySignup("not an email", false)).rejects.toThrow(RangeError);
    expect(await d.findNotifySignup("not an email")).toBeNull();
    expect(await d.unsubscribe("short")).toBe("unknown");
    expect(errorLog).not.toHaveBeenCalled();
  });
});

describe("getAccountData", () => {
  const g = globalThis as typeof globalThis & { __retrofitRuntime?: { accounts?: AccountData } };
  beforeEach(() => {
    if (g.__retrofitRuntime) g.__retrofitRuntime.accounts = undefined;
  });
  const local = () => loadConfig({ SESSION_SECRET: "s".repeat(32) });

  // Fails if production can run account data on a per-instance memory adapter (signups would be lost).
  it("throws on Vercel without Supabase configuration", () => {
    const config = { ...local(), onVercel: true, supabase: null };
    expect(() => getAccountData(config)).toThrow(/Supabase account data not configured/);
  });

  // Fails if configured Supabase is ignored in favour of memory (memory would answer null, not throw).
  it("uses Supabase when SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set", async () => {
    const config = loadConfig({ SESSION_SECRET: "s".repeat(32), SUPABASE_URL: CLOSED, SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY });
    await expect(getAccountData(config).findNotifySignup(EMAIL)).rejects.toBeInstanceOf(AccountDataUnavailable);
  });

  // Fails if local development without Supabase stops working.
  it("uses memory off Vercel without Supabase configuration", async () => {
    const data = getAccountData(local());
    await data.addNotifySignup("local@example.test", false);
    expect((await data.findNotifySignup("local@example.test"))?.email).toBe("local@example.test");
  });
});
