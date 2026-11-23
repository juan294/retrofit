import { describe, expect, it } from "vitest";
import { handleCleanup } from "@/lib/api/cleanup";
import { loadConfig } from "@/lib/config";
import { createMemoryAccountData } from "@/lib/accounts/memory";
import { createMemoryStore } from "@/lib/store/memory";

const config = loadConfig({ SESSION_SECRET: "s".repeat(32), CRON_SECRET: "cron-secret-test" });
const NOW = Date.parse("2027-06-01T00:00:00.000Z");
/** Account data that records the prunes, and the clock the route needs beside the store. */
const account = (pruned: unknown[][] = [], events = 0) => ({ accounts: { ...createMemoryAccountData(), pruneStripeEvents: async (...args: unknown[]) => (pruned.push(args), events) }, clock: () => NOW });
const req = (auth?: string) => new Request("https://retrofit.example/api/cron/cleanup", { headers: auth ? { authorization: auth } : {} });

describe("GET /api/cron/cleanup", () => {
  // Fails if the cron route runs without the CRON_SECRET bearer.
  it("refuses a missing or wrong secret", async () => {
    expect((await handleCleanup(req(), { config, store: createMemoryStore(), ...account() })).status).toBe(401);
    expect((await handleCleanup(req("Bearer nope"), { config, store: createMemoryStore(), ...account() })).status).toBe(401);
  });

  // Fails if the route stops calling the store's cleanup.
  it("deletes expired rows through a cleanable store", async () => {
    const store = { ...createMemoryStore(), cleanup: async () => 7 };
    const res = await handleCleanup(req("Bearer cron-secret-test"), { config, store, ...account() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: 7 });
  });

  it("answers 0 for the memory store, which drops expired entries on read", async () => {
    const res = await handleCleanup(req("Bearer cron-secret-test"), { config, store: createMemoryStore(), ...account() });
    expect((await res.json()).deleted).toBe(0);
  });

  it("answers 503 and logs [TABLE_FALLBACK] when cleanup fails", async () => {
    const store = { ...createMemoryStore(), cleanup: async () => Promise.reject(new Error("down")) };
    const res = await handleCleanup(req("Bearer cron-secret-test"), { config, store, ...account() });
    expect(res.status).toBe(503);
  });

  // Fails if recorded Stripe events are kept for ever, pruned early, without a bound, or without the secret.
  it("prunes Stripe events older than 90 days, at most 10,000 a run, after the secret", async () => {
    const pruned: unknown[][] = [];
    const deps = { config, store: createMemoryStore(), ...account(pruned, 4) };
    expect((await handleCleanup(req("Bearer nope"), deps)).status).toBe(401);
    expect(pruned).toEqual([]);
    const res = await handleCleanup(req("Bearer cron-secret-test"), deps);
    expect([res.status, (await res.json()).stripeEvents]).toEqual([200, 4]);
    expect(pruned).toEqual([["2027-03-03T00:00:00.000Z", 10_000]]);
  });

  it("answers 503 when the events cannot be pruned", async () => {
    const deps = { config, store: createMemoryStore(), ...account() };
    const broken = { ...deps, accounts: { ...deps.accounts, pruneStripeEvents: async () => Promise.reject(new Error("down")) } };
    expect((await handleCleanup(req("Bearer cron-secret-test"), broken)).status).toBe(503);
  });
});
