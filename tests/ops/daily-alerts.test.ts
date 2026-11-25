/**
 * DO-M2, BE-L1, SE-M1: a broken feature reaches the owner. Each condition opens one GitHub issue a day (the alert
 * repository is public: no address, host, customer id or error text), and one broken step does not stop another.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleClaimsRecheck } from "@/lib/api/claims-recheck";
import { handleCleanup } from "@/lib/api/cleanup";
import { handleConfirm } from "@/lib/api/confirm";
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
    const deps: TestDeps = { ...d, store: { ...d.store, cleanup: async () => (cleaned++, 7) }, accounts: { ...d.accounts, pruneStripeEvents: down, purgeUsersWithoutAccount: async () => (purged++, 0) } };
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

  // Fails if a Store that cannot mark the alert turns the crons' answers into an exception.
  it("answers 503 also when the alert itself cannot be marked", async () => {
    const { d } = setup();
    const store = { ...d.store, cleanup: down, putIfAbsent: down };
    expect((await handleCleanup(cron("cleanup"), { ...d, store })).status).toBe(503);
    expect((await handleClaimsRecheck(cron("claims"), { ...d, store, accounts: { ...d.accounts, listClaimsDueForRecheck: down } })).status).toBe(503);
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

  const purging = (d: TestDeps, purge: (n: number) => number) => {
    const calls: unknown[][] = [];
    return { calls, deps: { ...d, accounts: { ...d.accounts, purgeUsersWithoutAccount: async (...args: unknown[]) => (calls.push(args), purge(calls.length)) } } as TestDeps };
  };

  // SE-M2, reviewer note. Fails if unconfirmed users without an account are kept, purged while their link can still work, or
  // deleted in one statement that the database's time limit can stop (then no user is ever deleted).
  it("purges unconfirmed users older than a day in batches, until none is left", async () => {
    const { d } = setup();
    const { calls, deps } = purging(d, (n) => (n < 3 ? 500 : 4));
    const res = await handleCleanup(cron("cleanup"), deps);
    expect([res.status, (await res.json()).usersWithoutAccount]).toEqual([200, 1004]);
    expect(calls).toEqual(Array.from({ length: 3 }, () => ["2026-11-30T03:17:00.000Z", 500]));
    expect(sent).toEqual([]);
  });

  // Fails if a run has no bound, or goes on so long that the platform ends it (its time limit is 60 seconds) before the answer.
  it("a run purges at most 10,000 users, and starts no batch after 40 seconds", async () => {
    const bound = purging(setup().d, () => 500);
    const res = await handleCleanup(cron("cleanup"), bound.deps);
    expect([res.status, (await res.json()).usersWithoutAccount, bound.calls.length]).toEqual([200, 10_000, 20]);
    const { d, clock } = setup();
    const slow = purging(d, () => (clock.advance(20_000), 500));
    expect([(await handleCleanup(cron("cleanup"), slow.deps)).status, slow.calls.length]).toEqual([200, 2]);
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

// Review finding 2. Emails go out and every link ends at "unavailable": nobody can sign in, and no email failure says so.
describe("sign-in link checks", () => {
  const open = (d: TestDeps, n: number) =>
    handleConfirm(new Request("https://retrofit.test/auth/verify", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "same-origin", "x-real-ip": `198.51.100.${n}` }, body: `token_hash=${"a".repeat(56)}&type=email` }), d);

  // Fails if a provider that cannot check links reaches nobody, or is reported at the first failure or twice a day; or an unknown link counts.
  it("opens one issue a day from the third provider failure on, and none for links that are only expired", async () => {
    const { d } = setup();
    for (let n = 1; n <= 5; n++) expect((await open(d, n)).headers.get("location")).toBe("https://retrofit.test/sign-in?link=expired");
    await d.settle();
    expect(sent).toEqual([]);
    for (let n = 1; n <= 5; n++) {
      d.fixtureAuth.fail("verifyOtp");
      expect((await open(d, n)).headers.get("location")).toBe("https://retrofit.test/sign-in?link=unavailable");
      await d.settle();
      expect(sent).toHaveLength(n < 3 ? 0 : 1);
    }
    expect(titles()).toEqual(["Sign-in links cannot be checked"]);
    expect(JSON.stringify(sent)).not.toMatch(/example|aaaa/);
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

  // Review finding 1. Fails if addresses that the provider refuses (anybody can type them) open a public alert, or use up the day's real one.
  it("does not count an address that the provider refuses", async () => {
    const { d } = setup();
    for (let n = 1; n <= 4; n++) {
      d.fixtureAuth.fail("signInWithOtp", "refused");
      expect((await ask(d, n)).status).toBe(503);
    }
    await d.settle();
    expect(sent).toEqual([]);
    for (let n = 5; n <= 7; n++) {
      d.fixtureAuth.fail("signInWithOtp");
      await ask(d, n);
    }
    await d.settle();
    expect(titles()).toEqual(["Sign-in email stopped"]);
  });

  // Fails if a failed alert, a store that cannot count or mark, or a platform without background work changes the visitor's answer.
  it.each(["github", "store", "platform"])("never changes the visitor's answer: %s fails", async (what) => {
    const { d } = setup();
    if (what === "github") vi.stubGlobal("fetch", down);
    const store = { ...d.store, putIfAbsent: down, incrementWindow: (key: string, ...rest: [number]) => (key.startsWith("signin-provider") ? down() : d.store.incrementWindow(key, ...rest)) };
    const deps = { ...d, ...(what === "store" ? { store } : {}), ...(what === "platform" ? { waitUntil: () => { throw new Error("no request scope"); } } : {}) } as TestDeps;
    d.fixtureAuth.fail("signInWithOtp", "project_limited");
    expect((await ask(deps, 9)).status).toBe(429);
    d.fixtureAuth.fail("signInWithOtp");
    for (let n = 10; n < 14; n++) expect((await ask(deps, n)).status).toBe(503);
    await d.settle();
    expect(d.errors).toEqual([]);
  });
});
