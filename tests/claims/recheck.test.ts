/**
 * The daily recheck (src/lib/claims/recheck.ts, GET /api/cron/claims): verified and lapsed claims
 * last checked more than 24 hours ago, at most RECHECK_PER_RUN per run, within a time budget;
 * three consecutive failures lapse a claim and one pass restores it. A fake clock and a fake TXT
 * resolver; the meta path reads a loopback fixture site.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountData, Claim } from "@/lib/accounts/data";
import { handleClaimsRecheck } from "@/lib/api/claims-recheck";
import { RECHECK_BUDGET_MS, RECHECK_PER_RUN, recheckDueClaims } from "@/lib/claims/recheck";
import { claimView } from "@/lib/claims/view";
import { sha256Hex } from "@/lib/security/tokens";
import { CLAIMS_TEXT } from "@/lib/site/claims-texts";
import { startFixtureServer, type FixtureServer } from "../helpers/fixture-server";
import { fakeClock, noRealDns, PUBLIC_ORIGIN, testDeps, TEST_ACCOUNT } from "../helpers/server-deps";

const DAY = 24 * 3600_000;
const TOKEN = "0123456789abcdef0123456789abcdef";

let server: FixtureServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
  vi.restoreAllMocks();
});

/** A verified DNS claim for `host` of a new account, checked now. */
async function verifiedClaim(accounts: AccountData, host: string, at: number, accountId = crypto.randomUUID()): Promise<Claim> {
  const created = await accounts.createClaim(accountId, { host, method: "dns", tokenHash: sha256Hex(TOKEN) });
  if (created.outcome !== "created") throw new Error("create failed");
  const v = await accounts.verifyClaim(created.claim.id, { tokenHash: created.claim.tokenHash, checkedAt: new Date(at).toISOString() });
  if (v.outcome !== "verified") throw new Error("verify failed");
  return v.claim;
}

function setup() {
  const clock = fakeClock(Date.parse("2026-11-23T03:00:00.000Z"));
  const state = { records: [[`retrofit-site-verification=${TOKEN}`]] as string[][], lookups: [] as string[], onLookup: () => {} };
  const d = testDeps({
    clock: clock.clock,
    lookup: noRealDns,
    txt: async (name) => {
      state.lookups.push(name);
      state.onLookup();
      return state.records;
    },
  });
  return { d, clock, state };
}

describe("lapse and restore", () => {
  // Fails if a claim lapses before three consecutive failed daily checks, or not after them, or shows the wrong text.
  it("three failed rechecks lapse a verified claim; the owner sees the paused text with the date", async () => {
    const { d, clock, state } = setup();
    const c = await verifiedClaim(d.accounts, "lapse.example.com", clock.now(), TEST_ACCOUNT.userId);
    state.records = [];
    for (let day = 1; day <= 3; day++) {
      clock.advance(DAY + 60_000);
      expect(await recheckDueClaims(d)).toMatchObject({ checked: 1, failed: 1, lapsed: day === 3 ? 1 : 0 });
      expect((await d.accounts.getClaim(TEST_ACCOUNT.userId, c.id))?.status).toBe(day === 3 ? "lapsed" : "verified");
    }
    const lapsed = (await d.accounts.getClaim(TEST_ACCOUNT.userId, c.id))!;
    expect(lapsed.failures).toBe(3);
    expect(claimView(lapsed, d.config).statusText).toBe("Verification failed on 26 November 2026. Your published page and badge are paused.");
    expect(claimView(lapsed, d.config).statusText).toBe(CLAIMS_TEXT.status.lapsed(lapsed.lapsedAt!));
    // P3-R8. A later failed recheck keeps the date the claim lapsed.
    clock.advance(DAY + 60_000);
    await recheckDueClaims(d);
    const later = (await d.accounts.getClaim(TEST_ACCOUNT.userId, c.id))!;
    expect(later.lastCheckedAt).not.toBe(lapsed.lastCheckedAt);
    expect(claimView(later, d.config).statusText).toBe("Verification failed on 26 November 2026. Your published page and badge are paused.");
  });

  // Fails if a lapsed claim is not rechecked, or one passing check does not restore it with no failures.
  it("one passing recheck restores a lapsed claim", async () => {
    const { d, clock, state } = setup();
    const c = await verifiedClaim(d.accounts, "restore.example.com", clock.now(), TEST_ACCOUNT.userId);
    state.records = [];
    for (let day = 1; day <= 3; day++) {
      clock.advance(DAY + 60_000);
      await recheckDueClaims(d);
    }
    state.records = [[`retrofit-site-verification=${TOKEN}`]];
    clock.advance(DAY + 60_000);
    expect(await recheckDueClaims(d)).toMatchObject({ checked: 1, verified: 1 });
    expect(await d.accounts.getClaim(TEST_ACCOUNT.userId, c.id)).toMatchObject({ status: "verified", failures: 0, verifiedAt: new Date(clock.now()).toISOString() });
  });

  // Fails if a failure between two passes is not reset, so three non-consecutive failures would lapse the claim.
  it("only consecutive failures count", async () => {
    const { d, clock, state } = setup();
    const c = await verifiedClaim(d.accounts, "flaky.example.com", clock.now(), TEST_ACCOUNT.userId);
    for (const ok of [false, false, true, false, false]) {
      state.records = ok ? [[`retrofit-site-verification=${TOKEN}`]] : [];
      clock.advance(DAY + 60_000);
      await recheckDueClaims(d);
    }
    expect(await d.accounts.getClaim(TEST_ACCOUNT.userId, c.id)).toMatchObject({ status: "verified", failures: 2 });
  });
});

describe("what a run checks", () => {
  // Fails if a claim checked within 24 hours, a pending claim or a superseded claim is rechecked.
  it("skips claims checked within 24 hours, pending claims and superseded claims", async () => {
    const { d, clock, state } = setup();
    await verifiedClaim(d.accounts, "fresh.example.com", clock.now());
    await d.accounts.createClaim(crypto.randomUUID(), { host: "pending.example.com", method: "dns", tokenHash: sha256Hex(TOKEN) });
    const old = await verifiedClaim(d.accounts, "moved.example.com", clock.now() - 2 * DAY);
    await verifiedClaim(d.accounts, "moved.example.com", clock.now() - DAY - 60_000);
    clock.advance(DAY - 60_000);
    const summary = await recheckDueClaims(d);
    // Only the new holder of moved.example.com is due; fresh was checked 23 h 59 min ago.
    expect(summary).toMatchObject({ checked: 1, verified: 1 });
    expect(state.lookups).toEqual(["_retrofit-verification.moved.example.com"]);
    expect((await d.accounts.listClaimsDueForRecheck(new Date(clock.now()).toISOString(), 50)).some((c) => c.id === old.id)).toBe(false);
  });

  // Fails if one run checks more than RECHECK_PER_RUN claims, or the rest wait more than one more run.
  it(`checks at most ${RECHECK_PER_RUN} claims per run, least recently checked first`, async () => {
    const { d, clock, state } = setup();
    for (let n = 0; n < RECHECK_PER_RUN + 7; n++) await verifiedClaim(d.accounts, `cap${n}.example.com`, clock.now() + n * 1000);
    clock.advance(DAY + 3600_000);
    expect(await recheckDueClaims(d)).toMatchObject({ checked: RECHECK_PER_RUN, skipped: 0 });
    expect(state.lookups).toHaveLength(RECHECK_PER_RUN);
    expect(state.lookups[0]).toBe("_retrofit-verification.cap0.example.com");
    expect(await recheckDueClaims(d)).toMatchObject({ checked: 7 });
    expect(await recheckDueClaims(d)).toMatchObject({ checked: 0 });
  });

  // P3-R4. Fails if a run with more due claims than it may check says nothing, or names a host in the log.
  it("logs, with counts only, when more claims are due than one run checks", async () => {
    const { d, clock } = setup();
    const lines: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => void lines.push(args.join(" ")));
    for (let n = 0; n < RECHECK_PER_RUN; n++) await verifiedClaim(d.accounts, `full${n}.example.com`, clock.now());
    clock.advance(DAY + 60_000);
    await recheckDueClaims(d);
    expect(lines).toEqual([]);
    await verifiedClaim(d.accounts, "over.example.com", clock.now() - DAY - 60_000);
    for (let n = 0; n < RECHECK_PER_RUN; n++) await verifiedClaim(d.accounts, `more${n}.example.com`, clock.now() - DAY - 60_000);
    await recheckDueClaims(d);
    expect(lines).toEqual([`Claim recheck: more than ${RECHECK_PER_RUN} claims were due; the rest wait for the next run.`]);
    expect(lines.join("")).not.toMatch(/example/);
  });

  // P3-R2. Fails if a site whose Crawl-delay is longer than the run budget defers every recheck (its claim would never lapse).
  it("a Crawl-delay longer than the run budget fails the recheck with crawl_delay, so the claim can lapse", async () => {
    const { d, clock } = setup();
    server = await startFixtureServer({
      "slowbot.fixture.test": {
        "/robots.txt": { headers: { "content-type": "text/plain" }, body: "User-agent: *\nCrawl-delay: 86400\nAllow: /\n" },
        "/": { headers: { "content-type": "text/html" }, body: `<html><head><meta name="retrofit-site-verification" content="${TOKEN}"></head></html>` },
      },
    });
    const created = await d.accounts.createClaim(TEST_ACCOUNT.userId, { host: `slowbot.fixture.test:${server.port}`, method: "meta", tokenHash: sha256Hex(TOKEN) });
    if (created.outcome !== "created") throw new Error("create failed");
    await d.accounts.verifyClaim(created.claim.id, { tokenHash: created.claim.tokenHash, checkedAt: new Date(clock.now()).toISOString() });
    for (let day = 1; day <= 3; day++) {
      clock.advance(DAY + 60_000);
      expect(await recheckDueClaims(d)).toMatchObject({ checked: 1, failed: 1, skipped: 0 });
    }
    expect(await d.accounts.getClaim(TEST_ACCOUNT.userId, created.claim.id)).toMatchObject({ status: "lapsed", lastResult: "crawl_delay", lastDetail: 86400 });
    expect(server.requests.map((r) => r.path)).not.toContain("/");
  });

  // Fails if a run starts checks after its time budget (the cron would outlive its function), or records the skipped ones.
  it("starts no check after the time budget; the rest stay due", async () => {
    const { d, clock, state } = setup();
    for (let n = 0; n < 10; n++) await verifiedClaim(d.accounts, `slow${n}.example.com`, clock.now());
    clock.advance(DAY + 60_000);
    // Each lookup takes a third of the budget on the fake clock.
    state.onLookup = () => clock.advance(Math.ceil(RECHECK_BUDGET_MS / 3));
    const summary = await recheckDueClaims(d);
    expect(summary.checked).toBeLessThan(10);
    expect(summary.checked + summary.skipped).toBe(10);
    expect((await d.accounts.listClaimsDueForRecheck(new Date(clock.now()).toISOString(), 50)).length).toBe(summary.skipped);
  });

  // Fails if a meta recheck is not paced per host through the fetch context or ignores robots (the check reads robots.txt first).
  it("a meta recheck reads robots.txt and the home page of the claimed host", async () => {
    const { d, clock } = setup();
    server = await startFixtureServer({
      "meta.fixture.test": {
        "/robots.txt": { headers: { "content-type": "text/plain" }, body: "User-agent: *\nAllow: /\n" },
        "/": { headers: { "content-type": "text/html" }, body: `<html><head><meta name="retrofit-site-verification" content="${TOKEN}"></head><body></body></html>` },
      },
    });
    const created = await d.accounts.createClaim(TEST_ACCOUNT.userId, { host: `meta.fixture.test:${server.port}`, method: "meta", tokenHash: sha256Hex(TOKEN) });
    if (created.outcome !== "created") throw new Error("create failed");
    await d.accounts.verifyClaim(created.claim.id, { tokenHash: created.claim.tokenHash, checkedAt: new Date(clock.now()).toISOString() });
    clock.advance(DAY + 60_000);
    expect(await recheckDueClaims(d)).toMatchObject({ checked: 1, verified: 1 });
    expect(server.requests.map((r) => r.path)).toEqual(["/robots.txt", "/"]);
  });
});

describe("GET /api/cron/claims", () => {
  const cron = (auth?: string) => new Request(`${PUBLIC_ORIGIN}/api/cron/claims`, { headers: auth === undefined ? {} : { authorization: auth } });

  // Fails if the recheck runs without the exact Bearer CRON_SECRET, or without any secret configured.
  it("refuses without the Bearer secret, with a wrong one, and when CRON_SECRET is unset", async () => {
    const { d } = setup();
    const withSecret = { ...d, config: { ...d.config, free: { ...d.config.free, cronSecret: "c".repeat(32) } } };
    let listed = 0;
    const counting = { ...withSecret, accounts: { ...d.accounts, listClaimsDueForRecheck: async (...args: Parameters<AccountData["listClaimsDueForRecheck"]>) => (listed++, d.accounts.listClaimsDueForRecheck(...args)) } };
    for (const auth of [undefined, "", `Bearer ${"d".repeat(32)}`, `bearer ${"c".repeat(32)}`, "c".repeat(32)]) {
      const res = await handleClaimsRecheck(cron(auth), counting);
      expect(res.status, String(auth)).toBe(401);
    }
    expect((await handleClaimsRecheck(cron(`Bearer ${"c".repeat(32)}`), { ...counting, config: d.config })).status).toBe(401);
    expect(listed).toBe(0);
    const ok = await handleClaimsRecheck(cron(`Bearer ${"c".repeat(32)}`), counting);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ checked: 0, verified: 0, failed: 0, lapsed: 0, skipped: 0, errors: 0 });
    expect(listed).toBe(1);
  });

  // Fails if an account data outage answers 200 (Vercel would see a healthy run) or logs more than the error name.
  it("answers 503 when the account data is unavailable", async () => {
    const { d } = setup();
    const broken = { ...d, config: { ...d.config, free: { ...d.config.free, cronSecret: "c".repeat(32) } }, accounts: { ...d.accounts, listClaimsDueForRecheck: () => Promise.reject(new Error("down")) } };
    expect((await handleClaimsRecheck(cron(`Bearer ${"c".repeat(32)}`), broken)).status).toBe(503);
  });
});
