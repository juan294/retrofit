import { describe, expect, it, vi } from "vitest";
import { ConfigError, loadConfig } from "@/lib/config";
import { VERCEL_ENV } from "./helpers/vercel-env";

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
    // A budget equal to the lease is refused too, whatever FETCH_TIMEOUT_MS is.
    expect(() => loadConfig({ CRAWL_BUDGET_MS: "40000", FETCH_TIMEOUT_MS: "1", CRAWL_LEASE_TTL_S: "40", SESSION_SECRET: secret })).toThrow(/CRAWL_LEASE_TTL_S \* 1000/);
  });

  // Fails if a config lets the last request of a crawl (started at the end of the budget, lasting up to
  // FETCH_TIMEOUT_MS) end after the crawl lease runs out.
  it("enforces CRAWL_BUDGET_MS + FETCH_TIMEOUT_MS <= CRAWL_LEASE_TTL_S * 1000", () => {
    expect(() => loadConfig({ CRAWL_BUDGET_MS: "45000", FETCH_TIMEOUT_MS: "15001", CRAWL_LEASE_TTL_S: "60", SESSION_SECRET: secret })).toThrow(/CRAWL_BUDGET_MS \+ FETCH_TIMEOUT_MS/);
    expect(loadConfig({ CRAWL_BUDGET_MS: "45000", FETCH_TIMEOUT_MS: "15000", CRAWL_LEASE_TTL_S: "60", SESSION_SECRET: secret }).fetchTimeoutMs).toBe(15000);
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
    const c = loadConfig({ ...VERCEL_ENV, PUBLIC_ORIGIN: "https://r.example/" });
    expect(c.onVercel).toBe(true);
    expect(c.publicOrigin).toBe("https://r.example");
  });

  it("refuses a PUBLIC_ORIGIN that is not an origin", () => {
    expect(() => loadConfig({ PUBLIC_ORIGIN: "https://r.example/path", SESSION_SECRET: secret })).toThrow(/PUBLIC_ORIGIN/);
    expect(() => loadConfig({ PUBLIC_ORIGIN: "ftp://r.example", SESSION_SECRET: secret })).toThrow(/PUBLIC_ORIGIN/);
  });

  // Fails if production can start without the Supabase store (it would fall back to per-instance memory).
  it.each(["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"])("refuses missing %s on Vercel", (name) => {
    expect(() => loadConfig({ ...VERCEL_ENV, [name]: undefined })).toThrow(ConfigError);
    expect(() => loadConfig({ ...VERCEL_ENV, [name]: " " })).toThrow(new RegExp(name));
  });

  // Fails if the service role key could travel over plain HTTP in production.
  it("refuses an http SUPABASE_URL on Vercel", () => {
    expect(() => loadConfig({ ...VERCEL_ENV, SUPABASE_URL: "http://store.supabase.test" })).toThrow(/SUPABASE_URL/);
  });

  it("reads the Supabase variables on Vercel", () => {
    const c = loadConfig(VERCEL_ENV);
    expect(c.supabase).toEqual({ url: "https://store.supabase.test", serviceRoleKey: "service-role-key-test", anonKey: "anon-key-test" });
  });

  // Fails if local development needs Supabase, or a half configuration silently uses memory.
  it("leaves Supabase unset off Vercel and refuses only one of the two variables", () => {
    const c = loadConfig({ SESSION_SECRET: secret });
    expect(c.supabase).toBeNull();
    expect(() => loadConfig({ SESSION_SECRET: secret, SUPABASE_URL: "http://127.0.0.1:54721" })).toThrow(/SUPABASE_SERVICE_ROLE_KEY/);
    expect(() => loadConfig({ SESSION_SECRET: secret, SUPABASE_SERVICE_ROLE_KEY: "k" })).toThrow(/SUPABASE_URL/);
    const local = loadConfig({ SESSION_SECRET: secret, SUPABASE_URL: "http://127.0.0.1:54721/", SUPABASE_SERVICE_ROLE_KEY: "k" });
    expect(local.supabase).toEqual({ url: "http://127.0.0.1:54721", serviceRoleKey: "k" });
  });

  it("refuses a SUPABASE_URL that is not an http or https origin", () => {
    expect(() => loadConfig({ SESSION_SECRET: secret, SUPABASE_URL: "ftp://x.test", SUPABASE_SERVICE_ROLE_KEY: "k" })).toThrow(/SUPABASE_URL/);
    expect(() => loadConfig({ SESSION_SECRET: secret, SUPABASE_URL: "not a url", SUPABASE_SERVICE_ROLE_KEY: "k" })).toThrow(/SUPABASE_URL/);
  });
});

describe("billing start and notify limit", () => {
  // Fails if billing could start before judging ends (the brief's free-access rule) or the default moves.
  it("defaults BILLING_START to 2027-01-20T00:00:00Z and NOTIFY_PER_CLIENT_HOUR to 5", () => {
    const c = loadConfig({ SESSION_SECRET: secret });
    expect(c.billingStart).toBe(Date.parse("2027-01-20T00:00:00Z"));
    expect(c.notifyPerClientHour).toBe(5);
  });

  // Fails if BILLING_START is ignored or a bad value falls back to the default instead of refusing.
  it("reads BILLING_START as an ISO date and time and refuses anything else", () => {
    expect(loadConfig({ SESSION_SECRET: secret, BILLING_START: "2027-02-01T12:00:00Z" }).billingStart).toBe(Date.parse("2027-02-01T12:00:00Z"));
    for (const bad of ["soon", "2027-13-45"]) {
      expect(() => loadConfig({ SESSION_SECRET: secret, BILLING_START: bad })).toThrow(/BILLING_START/);
    }
  });

  // Fails if the notify limit cannot be set or a bad value is accepted.
  it("reads NOTIFY_PER_CLIENT_HOUR as a positive number", () => {
    expect(loadConfig({ SESSION_SECRET: secret, NOTIFY_PER_CLIENT_HOUR: "9" }).notifyPerClientHour).toBe(9);
    expect(() => loadConfig({ SESSION_SECRET: secret, NOTIFY_PER_CLIENT_HOUR: "0" })).toThrow(/NOTIFY_PER_CLIENT_HOUR/);
  });
});

describe("accounts sign-in configuration", () => {
  // Fails if a sign-in limit default moves (5 links per network and 3 per address an hour, the plan's design).
  it("defaults SIGNIN_PER_CLIENT_HOUR to 5 and SIGNIN_PER_EMAIL_HOUR to 3, and reads both as positive numbers", () => {
    const c = loadConfig({ SESSION_SECRET: secret });
    expect(c.signInPerClientHour).toBe(5);
    expect(c.signInPerEmailHour).toBe(3);
    const set = loadConfig({ SESSION_SECRET: secret, SIGNIN_PER_CLIENT_HOUR: "50", SIGNIN_PER_EMAIL_HOUR: "30" });
    expect([set.signInPerClientHour, set.signInPerEmailHour]).toEqual([50, 30]);
    expect(() => loadConfig({ SESSION_SECRET: secret, SIGNIN_PER_EMAIL_HOUR: "0" })).toThrow(/SIGNIN_PER_EMAIL_HOUR/);
  });

  // Fails if production can start without the anon key that sign-in needs (every sign-in would answer 503).
  it("refuses a missing SUPABASE_ANON_KEY on Vercel and reads it when set", () => {
    const { SUPABASE_ANON_KEY: _omit, ...withoutAnon } = VERCEL_ENV;
    expect(() => loadConfig(withoutAnon)).toThrow(/SUPABASE_ANON_KEY/);
    expect(loadConfig(VERCEL_ENV).supabase?.anonKey).toBe(VERCEL_ENV.SUPABASE_ANON_KEY);
  });

  // Fails if local development without the anon key stops working, or an anon key without a Supabase URL is accepted.
  it("leaves SUPABASE_ANON_KEY optional off Vercel and refuses it without SUPABASE_URL", () => {
    expect(loadConfig({ SESSION_SECRET: secret }).supabase).toBeNull();
    expect(loadConfig({ SESSION_SECRET: secret, SUPABASE_URL: "http://127.0.0.1:54721", SUPABASE_SERVICE_ROLE_KEY: "k" }).supabase?.anonKey).toBeUndefined();
    expect(loadConfig({ SESSION_SECRET: secret, SUPABASE_URL: "http://127.0.0.1:54721", SUPABASE_SERVICE_ROLE_KEY: "k", SUPABASE_ANON_KEY: " a " }).supabase?.anonKey).toBe("a");
    expect(() => loadConfig({ SESSION_SECRET: secret, SUPABASE_ANON_KEY: "a" })).toThrow(/SUPABASE_URL/);
  });
});
