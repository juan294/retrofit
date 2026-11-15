import { describe, expect, it, vi } from "vitest";
import { ConfigError, loadConfig } from "@/lib/config";

const secret = "s".repeat(32);

describe("loadConfig", () => {
  // Fails if any default in the plan's Phase 1 table changes.
  it("applies every default off Vercel", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const c = loadConfig({});
    expect(c).toMatchObject({
      crawlMaxPages: 12,
      fetchTimeoutMs: 8000,
      fetchMaxBytes: 2097152,
      crawlBudgetMs: 45000,
      crawlLeaseTtlS: 60,
      crawlCacheTtlS: 86400,
      crawlMaxConcurrent: 8,
      crawlMaxHostsPerDay: 1000,
      queueMaxWaitS: 120,
      analysesPerClientHour: 20,
      staleAfterS: 90,
      analysisTtlS: 604800,
      scoreWaitMs: 25000,
      publicOrigin: "http://127.0.0.1:3010",
      onVercel: false,
      fixturesEnabled: false,
    });
    expect(c.sessionSecret.length).toBeGreaterThanOrEqual(32);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("SESSION_SECRET"));
    expect(Object.isFrozen(c)).toBe(true);
    warn.mockRestore();
  });

  // Fails if number parsing silently falls back to a default.
  it.each(["abc", "0", "-3", "1.5x"])("names the variable for a bad number %s", (v) => {
    expect(() => loadConfig({ CRAWL_MAX_PAGES: v, SESSION_SECRET: secret })).toThrow(ConfigError);
    expect(() => loadConfig({ CRAWL_MAX_PAGES: v, SESSION_SECRET: secret })).toThrow(/CRAWL_MAX_PAGES/);
  });

  // Fails if the lease/stale ordering rule is removed.
  it("enforces CRAWL_LEASE_TTL_S < STALE_AFTER_S", () => {
    expect(() => loadConfig({ CRAWL_LEASE_TTL_S: "90", STALE_AFTER_S: "90", SESSION_SECRET: secret })).toThrow(/CRAWL_LEASE_TTL_S/);
  });

  it("enforces CRAWL_BUDGET_MS < CRAWL_LEASE_TTL_S * 1000", () => {
    expect(() => loadConfig({ CRAWL_BUDGET_MS: "45000", CRAWL_LEASE_TTL_S: "40", SESSION_SECRET: secret })).toThrow(/CRAWL_LEASE_TTL_S \* 1000/);
  });

  // Fails if a budget that leaves no time to start a crawl inside one 60 s invocation is accepted.
  it("refuses CRAWL_BUDGET_MS above 50000", () => {
    expect(() => loadConfig({ CRAWL_BUDGET_MS: "50001", SESSION_SECRET: secret })).toThrow(/CRAWL_BUDGET_MS/);
    expect(loadConfig({ CRAWL_BUDGET_MS: "50000", SESSION_SECRET: secret }).crawlBudgetMs).toBe(50000);
  });

  // Fails if Vercel detection or its required variables are dropped.
  it.each([{ VERCEL: "1" }, { VERCEL_ENV: "production" }])("refuses missing SESSION_SECRET on Vercel %o", (flag) => {
    expect(() => loadConfig({ ...flag, PUBLIC_ORIGIN: "https://retrofit.example" })).toThrow(/SESSION_SECRET/);
  });

  it("refuses a short SESSION_SECRET on Vercel", () => {
    expect(() => loadConfig({ VERCEL: "1", PUBLIC_ORIGIN: "https://r.example", SESSION_SECRET: "short" })).toThrow(/SESSION_SECRET/);
  });

  it("refuses missing PUBLIC_ORIGIN on Vercel", () => {
    expect(() => loadConfig({ VERCEL: "1", SESSION_SECRET: secret })).toThrow(/PUBLIC_ORIGIN/);
  });

  it.each([{ VERCEL: "1" }, { VERCEL_ENV: "preview" }])("refuses RETROFIT_TEST_FIXTURES on Vercel %o", (flag) => {
    expect(() =>
      loadConfig({ ...flag, SESSION_SECRET: secret, PUBLIC_ORIGIN: "https://r.example", RETROFIT_TEST_FIXTURES: "1" }),
    ).toThrow(/RETROFIT_TEST_FIXTURES/);
  });

  // Fails if fixturesEnabled is tied to NODE_ENV.
  it("accepts fixtures with NODE_ENV=production off Vercel", () => {
    const c = loadConfig({ NODE_ENV: "production", RETROFIT_TEST_FIXTURES: "1", SESSION_SECRET: secret });
    expect(c.fixturesEnabled).toBe(true);
  });

  it("accepts a valid Vercel configuration", () => {
    const c = loadConfig({ VERCEL: "1", SESSION_SECRET: secret, PUBLIC_ORIGIN: "https://r.example/" });
    expect(c.onVercel).toBe(true);
    expect(c.publicOrigin).toBe("https://r.example");
  });

  it("refuses a PUBLIC_ORIGIN that is not an origin", () => {
    expect(() => loadConfig({ PUBLIC_ORIGIN: "https://r.example/path", SESSION_SECRET: secret })).toThrow(/PUBLIC_ORIGIN/);
    expect(() => loadConfig({ PUBLIC_ORIGIN: "ftp://r.example", SESSION_SECRET: secret })).toThrow(/PUBLIC_ORIGIN/);
  });
});
