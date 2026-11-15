/**
 * Stuck state "Store unavailable in production" (parent plan): the Supabase
 * adapter pointed at a closed port fails closed, logs [TABLE_FALLBACK] at
 * ERROR, and /api/health answers degraded with the visitor text. No database
 * is needed; this is the one test outside tests/db/** allowed to import the
 * adapter (eslint-rules/no-supabase-in-tests.mjs).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleHealth, HEALTH_DEGRADED_MESSAGE } from "@/lib/api/health";
import { loadConfig } from "@/lib/config";
import { getStore } from "@/lib/server/runtime";
import { createMemoryStore } from "@/lib/store/memory";
import { createSupabaseStore, StoreUnavailable } from "@/lib/store/supabase";
import type { Store } from "@/lib/store/types";

const CLOSED = "http://127.0.0.1:1";
const SERVICE_KEY = "service-role-test-secret";
const closedStore = () => createSupabaseStore({ url: CLOSED, serviceRoleKey: SERVICE_KEY, timeoutMs: 2000 });

let errorLog: ReturnType<typeof vi.spyOn>;
const logged = (): string[] => errorLog.mock.calls.map((args: unknown[]) => args.map(String).join(" "));

beforeEach(() => {
  errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  errorLog.mockRestore();
});

describe("Supabase adapter on a closed port", () => {
  const ops: Array<[string, (s: Store) => Promise<unknown>]> = [
    ["get", (s) => s.get("analysis:secret-tail")],
    ["set", (s) => s.set("analysis:secret-tail", { private: "value-xyz" }, 60)],
    ["delete", (s) => s.delete("analysis:secret-tail")],
    ["putIfAbsent", (s) => s.putIfAbsent("analysis:secret-tail", { private: "value-xyz" }, 60)],
    ["compareAndSet", (s) => s.compareAndSet("analysis:secret-tail", { version: 1 }, { version: 2 }, 60)],
    ["incrementWindow", (s) => s.incrementWindow("analysis:secret-tail", 60)],
    ["acquireLease", (s) => s.acquireLease("analysis:secret-tail", 60)],
    ["renewLease", (s) => s.renewLease("analysis:secret-tail", "token-xyz", 60)],
    ["releaseLease", (s) => s.releaseLease("analysis:secret-tail", "token-xyz")],
    ["enqueue", (s) => s.enqueue("analysis:secret-tail", "item-xyz", 60)],
    ["claimNext", (s) => s.claimNext("analysis:secret-tail")],
  ];

  // Fails if a failed cleanup reports zero deleted rows instead of failing closed.
  it("cleanup throws StoreUnavailable and logs [TABLE_FALLBACK]", async () => {
    await expect(closedStore().cleanup()).rejects.toBeInstanceOf(StoreUnavailable);
    expect(logged()[0]).toContain("[TABLE_FALLBACK] store cleanup failed");
  });

  // Fails if a failed call resolves (for example to null, as a fallback would) instead of throwing,
  // or if it is logged below ERROR, without [TABLE_FALLBACK], or with the value, key tail or secret.
  it.each(ops)("%s throws StoreUnavailable and logs [TABLE_FALLBACK] at ERROR", async (op, run) => {
    const store = closedStore();
    await expect(run(store)).rejects.toBeInstanceOf(StoreUnavailable);
    const lines = logged();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("[TABLE_FALLBACK]");
    expect(lines[0]).toContain(`store ${op} failed`);
    expect(lines[0]).toContain('key prefix "analysis"');
    for (const secret of ["secret-tail", "value-xyz", "token-xyz", "item-xyz", SERVICE_KEY]) expect(lines[0]).not.toContain(secret);
  });

  // Fails if argument checks need the network (a bad TTL would be reported as an outage).
  it("rejects a bad TTL or version locally with RangeError and logs nothing", async () => {
    const store = closedStore();
    await expect(store.set("k", 1, 0)).rejects.toThrow(RangeError);
    await expect(store.acquireLease("k", -1)).rejects.toThrow(RangeError);
    await expect(store.compareAndSet("k", { version: 1 }, { version: 3 }, 60)).rejects.toThrow(RangeError);
    expect(errorLog).not.toHaveBeenCalled();
  });
});

describe("GET /api/health", () => {
  // Fails if health reports ok without a working store, or the status, body or text differ from the stuck-state row.
  it("answers degraded with 503 and the visitor text when the store is unreachable", async () => {
    const response = await handleHealth({ store: closedStore() });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: "degraded", message: "Retrofit is having trouble. Try again in a few minutes." });
    expect(HEALTH_DEGRADED_MESSAGE).toBe("Retrofit is having trouble. Try again in a few minutes.");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(logged().some((l) => l.includes("[TABLE_FALLBACK]"))).toBe(true);
  });

  // Fails if health does not actually write and read a row (a read of a missing row must not pass).
  it("answers degraded when the row it wrote does not read back", async () => {
    const memory = createMemoryStore();
    const forgetful: Store = { ...memory, get: async () => null };
    const response = await handleHealth({ store: forgetful });
    expect(response.status).toBe(503);
    expect(logged().some((l) => l.includes("[TABLE_FALLBACK]") && l.includes("health"))).toBe(true);
  });

  // Fails if a working store is reported degraded, or the probe row has no 60 s TTL under a health: key.
  it("answers ok with 200 after writing and reading a health row with a 60 s TTL", async () => {
    const memory = createMemoryStore();
    const writes: Array<[string, number]> = [];
    const store: Store = { ...memory, set: (key, value, ttl) => (writes.push([key, ttl]), memory.set(key, value, ttl)) };
    const response = await handleHealth({ store });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
    expect(writes).toHaveLength(1);
    expect(writes[0]![0]).toMatch(/^health:[0-9a-f-]{36}$/);
    expect(writes[0]![1]).toBe(60);
  });
});

describe("getStore", () => {
  const g = globalThis as typeof globalThis & { __retrofitRuntime?: { store?: Store } };
  beforeEach(() => {
    if (g.__retrofitRuntime) g.__retrofitRuntime.store = undefined;
  });
  const local = () => loadConfig({ SESSION_SECRET: "s".repeat(32) });

  // Fails if production can run without the Supabase store (a per-instance memory store would split state).
  it("throws on Vercel without Supabase configuration", () => {
    const config = { ...local(), onVercel: true, supabaseUrl: null, supabaseServiceRoleKey: null };
    expect(() => getStore(config)).toThrow(/Supabase store not configured/);
  });

  // Fails if configured Supabase is ignored in favour of memory (a closed-port memory store would answer null, not throw).
  it("uses the Supabase store when SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are set", async () => {
    const config = loadConfig({ SESSION_SECRET: "s".repeat(32), SUPABASE_URL: CLOSED, SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY });
    await expect(getStore(config).get("probe:x")).rejects.toBeInstanceOf(StoreUnavailable);
  });

  // Fails if local development without Supabase stops working.
  it("uses memory off Vercel without Supabase configuration", async () => {
    const store = getStore(local());
    await store.set("probe:x", 1, 60);
    expect(await store.get("probe:x")).toBe(1);
  });
});

describe("health probe rows", () => {
  // Fails if each health check leaves its probe row behind (repeated checks would grow the table).
  it("deletes its probe row after reading it", async () => {
    const { createMemoryBacking, createMemoryStore } = await import("@/lib/store/memory");
    const backing = createMemoryBacking();
    const store = createMemoryStore({ backing });
    for (let i = 0; i < 5; i++) expect((await handleHealth({ store })).status).toBe(200);
    expect([...backing.values.keys()].filter((k) => k.startsWith("health:"))).toEqual([]);
  });
});
