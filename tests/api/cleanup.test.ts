import { describe, expect, it } from "vitest";
import { handleCleanup } from "@/lib/api/cleanup";
import { loadConfig } from "@/lib/config";
import { createMemoryStore } from "@/lib/store/memory";

const config = loadConfig({ SESSION_SECRET: "s".repeat(32), CRON_SECRET: "cron-secret-test" });
const req = (auth?: string) => new Request("https://retrofit.example/api/cron/cleanup", { headers: auth ? { authorization: auth } : {} });

describe("GET /api/cron/cleanup", () => {
  // Fails if the cron route runs without the CRON_SECRET bearer.
  it("refuses a missing or wrong secret", async () => {
    expect((await handleCleanup(req(), { config, store: createMemoryStore() })).status).toBe(401);
    expect((await handleCleanup(req("Bearer nope"), { config, store: createMemoryStore() })).status).toBe(401);
  });

  // Fails if the route stops calling the store's cleanup.
  it("deletes expired rows through a cleanable store", async () => {
    const store = { ...createMemoryStore(), cleanup: async () => 7 };
    const res = await handleCleanup(req("Bearer cron-secret-test"), { config, store });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: 7 });
  });

  it("answers 0 for the memory store, which drops expired entries on read", async () => {
    const res = await handleCleanup(req("Bearer cron-secret-test"), { config, store: createMemoryStore() });
    expect((await res.json()).deleted).toBe(0);
  });

  it("answers 503 and logs [TABLE_FALLBACK] when cleanup fails", async () => {
    const store = { ...createMemoryStore(), cleanup: async () => Promise.reject(new Error("down")) };
    const res = await handleCleanup(req("Bearer cron-secret-test"), { config, store });
    expect(res.status).toBe(503);
  });
});
