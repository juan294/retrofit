/**
 * DO-M2, BE-L1, SE-M1: a broken feature reaches the owner. Each condition opens one GitHub issue a day (the alert
 * repository is public: no address, host, customer id or error text), and one broken step does not stop another.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleClaimsRecheck } from "@/lib/api/claims-recheck";
import { handleCleanup } from "@/lib/api/cleanup";
import { handleSignIn } from "@/lib/api/sign-in";
import { CRON_SECRET, GITHUB_TOKEN } from "../helpers/ops";
import { fakeClock, postRequest, testDeps, type TestDeps } from "../helpers/server-deps";

let sent: { title: string; body: string }[];
beforeEach(() => {
  sent = [];
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.stubGlobal("fetch", async (url: unknown, init?: RequestInit) => {
    if (!String(url).startsWith("https://api.github.com/")) throw new Error(`unexpected network call to ${String(url)}`);
    sent.push(JSON.parse(String(init?.body)));
    return new Response("{}", { status: 201 });
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const setup = () => {
  const clock = fakeClock(Date.parse("2026-12-01T03:17:00.000Z"));
  return { clock, d: testDeps({ clock: clock.clock, env: { CRON_SECRET, ALERT_GITHUB_TOKEN: GITHUB_TOKEN } }) };
};
const cron = (path: string) => new Request(`https://retrofit.test/api/cron/${path}`, { headers: { authorization: `Bearer ${CRON_SECRET}` } });
const down = () => Promise.reject(new Error("secret detail of shop.example.com"));
const titles = () => sent.map((s) => s.title);

describe("the daily cleanup", () => {
  // Fails if a failing billing prune keeps expired Store rows (sessions, keyed hashes), the failure is hidden, or no issue is opened.
  it("runs every step although one fails, answers 503 and opens one issue a day", async () => {
    const { d, clock } = setup();
    let cleaned = 0;
    let purged = 0;
    const deps: TestDeps = { ...d, store: { ...d.store, cleanup: async () => (cleaned++, 7) }, accounts: { ...d.accounts, pruneStripeEvents: down, purgeUnconfirmedUsers: async () => (purged++, 0) } };
    for (let n = 0; n < 2; n++) {
      const res = await handleCleanup(cron("cleanup"), deps);
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ error: "unavailable", deleted: 7, failed: ["stripe_events"] });
    }
    expect([cleaned, purged]).toEqual([2, 2]);
    expect(titles()).toEqual(["The daily cleanup failed"]);
    expect(JSON.stringify(sent)).not.toMatch(/secret|example/);
    clock.advance(86_400_000);
    await handleCleanup(cron("cleanup"), deps);
    expect(sent).toHaveLength(2);
  });

  // Fails if a Store failure stops the account steps.
  it("runs the account steps when the Store cleanup fails", async () => {
    const { d } = setup();
    let pruned = 0;
    const deps = { ...d, store: { ...d.store, cleanup: down }, accounts: { ...d.accounts, pruneStripeEvents: async () => (pruned++, 3) } };
    const res = await handleCleanup(cron("cleanup"), deps);
    expect([res.status, pruned]).toEqual([503, 1]);
    expect(await res.json()).toMatchObject({ stripeEvents: 3, failed: ["store"] });
  });

  // SE-M2. Fails if unconfirmed users without an account are kept, purged while their link can still work, or without a bound.
  it("purges unconfirmed users older than a day, at most 1,000 a run", async () => {
    const { d } = setup();
    const calls: unknown[][] = [];
    const deps = { ...d, accounts: { ...d.accounts, purgeUnconfirmedUsers: async (...args: unknown[]) => (calls.push(args), 4) } };
    const res = await handleCleanup(cron("cleanup"), deps as TestDeps);
    expect([res.status, (await res.json()).unconfirmedUsers]).toEqual([200, 4]);
    expect(calls).toEqual([["2026-11-30T03:17:00.000Z", 1000]]);
    expect(sent).toEqual([]);
  });
});

describe("the daily claim recheck", () => {
  // Fails if a run that failed, or that could not record checks, reaches nobody.
  it("opens one issue a day when it fails or has errors", async () => {
    const failing = setup();
    const broken = { ...failing.d, accounts: { ...failing.d.accounts, listClaimsDueForRecheck: down } };
    expect((await handleClaimsRecheck(cron("claims"), broken)).status).toBe(503);
    await handleClaimsRecheck(cron("claims"), broken);
    expect(titles()).toEqual(["The daily claim recheck failed"]);
    sent = [];
    const healthy = setup();
    expect((await handleClaimsRecheck(cron("claims"), healthy.d)).status).toBe(200);
    expect(sent).toEqual([]);
    const created = await healthy.d.accounts.createClaim("4f1c2b8e-1d2a-4e55-9c3b-2a1b0c9d8e7f", { host: "shop.example.com", method: "dns", tokenHash: "a".repeat(64) });
    if (created.outcome !== "created") throw new Error("create failed");
    await healthy.d.accounts.verifyClaim(created.claim.id, { tokenHash: "a".repeat(64), checkedAt: "2026-11-01T00:00:00.000Z" });
    const errors = { ...healthy.d, txt: async () => [], accounts: { ...healthy.d.accounts, recordClaimFailure: down } };
    const res = await handleClaimsRecheck(cron("claims"), errors);
    expect((await res.json()).errors).toBe(1);
    expect(titles()).toEqual(["The daily claim recheck failed"]);
    expect(JSON.stringify(sent)).not.toMatch(/example|secret/);
  });
});

describe("sign-in mail", () => {
  const ask = (d: TestDeps, n: number) => handleSignIn(postRequest("/api/auth/sign-in", { email: `p${n}@example.test` }, { ip: `198.51.100.${n}` }), d);

  // Fails if the project's email limit, which stops sign-in for everybody, is silent, or is reported more than once a day.
  it("opens one issue a day when the provider's email limit is used up", async () => {
    const { d } = setup();
    for (let n = 1; n <= 3; n++) {
      d.fixtureAuth.fail("signInWithOtp", "project_limited");
      expect((await ask(d, n)).status).toBe(429);
    }
    await d.settle();
    expect(titles()).toEqual(["Sign-in email stopped"]);
    expect(JSON.stringify(sent)).not.toMatch(/example/);
  });

  // Fails if a provider outage is never reported, or one transient failure already is.
  it("opens one issue a day from the third provider failure on", async () => {
    const { d, clock } = setup();
    for (let n = 1; n <= 5; n++) {
      d.fixtureAuth.fail("signInWithOtp");
      expect((await ask(d, n)).status).toBe(503);
      await d.settle();
      expect(sent).toHaveLength(n < 3 ? 0 : 1);
    }
    clock.advance(86_400_000);
    d.fixtureAuth.fail("signInWithOtp");
    await ask(d, 6);
    await d.settle();
    expect(sent).toHaveLength(1);
  });

  // Fails if a failed alert, or a store that cannot count, changes the visitor's answer.
  it("never changes the visitor's answer", async () => {
    const { d } = setup();
    vi.stubGlobal("fetch", down);
    d.fixtureAuth.fail("signInWithOtp", "project_limited");
    expect((await ask(d, 9)).status).toBe(429);
    await d.settle();
    expect(d.errors).toEqual([]);
  });
});
