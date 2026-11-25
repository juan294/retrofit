/**
 * The claim API (src/lib/api/claims.ts): same-origin, signed-in, the claim and its source must belong
 * to the account, small bodies, the pending limit and the check limit. DNS checks use a fake TXT
 * resolver; no test reaches the network or real DNS.
 */
import { describe, expect, it } from "vitest";
import { CLAIM_CHANGES_PER_HOUR, CLAIM_CHECKS_PER_HOUR, MAX_PENDING_CLAIMS } from "@/lib/accounts/limits";
import { handleCheckClaim, handleCreateClaim, handleRemoveClaim, handleStartOverClaim } from "@/lib/api/claims";
import type { ClaimView } from "@/lib/claims/view";
import { sha256Hex } from "@/lib/security/tokens";
import { CLAIMS_TEXT } from "@/lib/site/claims-texts";
import { accountCookie, fakeClock, OTHER_ACCOUNT, postRequest, storeAnalysis, testDeps, TEST_ACCOUNT, type TestDeps } from "../helpers/server-deps";

type Answer = { error?: string; message?: string; claim?: ClaimView; token?: string; retryAt?: string };
const read = async (res: Response) => (await res.json()) as Answer;

/** The id of an analysis of `origin` attached to `accountId` (or to nobody). */
const analysisOf = async (d: TestDeps, origin: string, accountId?: string) => (await storeAnalysis(d, { inputOrigin: origin, ...(accountId ? { accountId } : {}) })).id;

async function setup(o: { clock?: ReturnType<typeof fakeClock>; records?: string[][] } = {}) {
  const records = { current: o.records ?? [] };
  const d = testDeps({ clock: o.clock?.clock, txt: async () => records.current });
  const owner = await accountCookie(d, TEST_ACCOUNT);
  const other = await accountCookie(d, OTHER_ACCOUNT);
  const create = (body: unknown, cookie = owner, extra = {}) => handleCreateClaim(postRequest("/api/claims", body, { cookie, ...extra }), d);
  const check = (claimId: string, cookie = owner) => handleCheckClaim(postRequest("/api/claims/check", { claimId }, { cookie }), d);
  const startOver = (body: unknown, cookie = owner) => handleStartOverClaim(postRequest("/api/claims/start-over", body, { cookie }), d);
  const remove = (claimId: string, cookie = owner) => handleRemoveClaim(postRequest("/api/claims/remove", { claimId }, { cookie }), d);
  return { d, owner, other, records, create, check, startOver, remove };
}

describe("POST /api/claims (create)", () => {
  // Fails if a claim can be created signed out, from another site, or with a body that is not small JSON.
  it("refuses signed-out (401), cross-origin (403) and too large (413) requests", async () => {
    const { d, create } = await setup();
    const id = await analysisOf(d, "https://shop.example.com", TEST_ACCOUNT.userId);
    expect((await create({ source: `analysis:${id}`, method: "dns" }, "")).status).toBe(401);
    const cross = await create({ source: `analysis:${id}`, method: "dns" }, undefined, { fetchSite: "cross-site", origin: "https://evil.example" });
    expect(cross.status).toBe(403);
    expect((await read(cross)).message).toBe(CLAIMS_TEXT.crossOrigin);
    expect((await create(JSON.stringify({ source: `analysis:${id}`, method: "dns", pad: "x".repeat(4000) }))).status).toBe(413);
    expect(await d.accounts.listClaims(TEST_ACCOUNT.userId)).toEqual([]);
  });

  // Fails if the host can come from anything but an analysis or saved report the account owns (a typed host, another account's, a visitor's).
  it("takes the host only from the account's own analysis or saved report: anything else is 400 or 404", async () => {
    const { d, create, other } = await setup();
    const mine = await analysisOf(d, "https://shop.example.com", TEST_ACCOUNT.userId);
    const theirs = await analysisOf(d, "https://theirs.example.com", OTHER_ACCOUNT.userId);
    const unattached = await analysisOf(d, "https://visitor.example.com");
    for (const body of [{ host: "shop.example.com", method: "dns" }, { source: "shop.example.com", method: "dns" }, { source: `analysis:${mine}`, method: "email" }, { source: `report:not-a-uuid`, method: "meta" }]) {
      const res = await create(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect((await read(res)).message).toBe(CLAIMS_TEXT.invalid);
    }
    for (const source of [`analysis:${theirs}`, `analysis:${unattached}`, "analysis:0123456789abcdef0123456789abcdef", "report:00000000-0000-4000-8000-000000000000"]) {
      const res = await create({ source, method: "dns" });
      expect(res.status, source).toBe(404);
      expect((await read(res)).message).toBe(CLAIMS_TEXT.notFound);
    }
    expect((await create({ source: `analysis:${mine}`, method: "dns" }, other)).status).toBe(404);
    expect(await d.accounts.listClaims(TEST_ACCOUNT.userId)).toEqual([]);
  });

  // Fails if the token is not shown once at creation, is stored raw, or the claim is not for the analysis's exact host.
  it("creates a pending claim for the analysis's exact host and shows the token once; only its hash is stored", async () => {
    const { d, create } = await setup();
    const id = await analysisOf(d, "https://WWW.Shop.example.com", TEST_ACCOUNT.userId);
    const res = await create({ source: `analysis:${id}`, method: "meta" });
    expect(res.status).toBe(201);
    const body = await read(res);
    expect(body.token).toMatch(/^[0-9a-f]{32}$/);
    expect(body.message).toBe(CLAIMS_TEXT.created);
    expect(body.claim).toMatchObject({ host: "www.shop.example.com", method: "meta", status: "pending", url: "https://www.shop.example.com/" });
    expect(JSON.stringify(body.claim)).not.toContain(body.token as string);
    const [stored] = await d.accounts.listClaims(TEST_ACCOUNT.userId);
    expect(stored?.tokenHash).toBe(sha256Hex(body.token as string));
    expect(JSON.stringify([...d.accountsBacking.claims.values()])).not.toContain(body.token as string);
    const again = await create({ source: `analysis:${id}`, method: "dns" });
    expect(again.status).toBe(409);
    expect(await read(again)).toMatchObject({ error: "exists", message: CLAIMS_TEXT.exists });
  });

  // Fails if a claim token is ever fixed or repeated, also for a fixture host in fixtures mode (browser tests read it from the page).
  it("every claim gets a new random token, fixture hosts in fixtures mode included", async () => {
    const { d, create, other } = await setup();
    const tokens: string[] = [];
    for (const [cookie, accountId] of [[undefined, TEST_ACCOUNT.userId], [other, OTHER_ACCOUNT.userId]] as const) {
      const body = await read(await create({ source: `analysis:${await analysisOf(d, "http://bakery.fixture.test:3011", accountId)}`, method: "meta" }, cookie));
      expect(body.claim?.host).toBe("bakery.fixture.test:3011");
      tokens.push(body.token as string);
    }
    for (const t of tokens) expect(t).toMatch(/^[0-9a-f]{32}$/);
    expect(tokens[0]).not.toBe(tokens[1]);
  });

  // Fails if a saved report cannot be the source, or a host that is not a public website is accepted.
  it("creates from a saved report; a host that is not a public website is 400", async () => {
    const { d, create } = await setup();
    const report = (host: string) => ({ status: "ready", host, score: 50, fetchedAt: "2026-11-23T10:00:00.000Z" });
    const saved = await d.accounts.saveReport(TEST_ACCOUNT.userId, { host: "saved.example.org", report: report("saved.example.org"), fetchedAt: "2026-11-23T10:00:00.000Z" });
    const ip = await d.accounts.saveReport(TEST_ACCOUNT.userId, { host: "10.0.0.1", report: report("10.0.0.1"), fetchedAt: "2026-11-23T10:00:00.000Z" });
    if (saved.outcome === "full" || ip.outcome === "full") throw new Error("save failed");
    const res = await create({ source: `report:${saved.report.id}`, method: "dns" });
    expect(res.status).toBe(201);
    expect((await read(res)).claim).toMatchObject({ host: "saved.example.org", method: "dns", recordName: "_retrofit-verification.saved.example.org" });
    const refused = await create({ source: `report:${ip.report.id}`, method: "dns" });
    expect(refused.status).toBe(400);
    expect((await read(refused)).message).toBe(CLAIMS_TEXT.notPublic);
  });

  // Fails if an account can hold more than MAX_PENDING_CLAIMS pending claims through the API.
  it(`answers 409 full past ${MAX_PENDING_CLAIMS} pending claims`, async () => {
    const { d, create } = await setup();
    for (let n = 0; n < MAX_PENDING_CLAIMS; n++) expect((await create({ source: `analysis:${await analysisOf(d, `https://s${n}.example.com`, TEST_ACCOUNT.userId)}`, method: "dns" })).status).toBe(201);
    const res = await create({ source: `analysis:${await analysisOf(d, "https://over.example.com", TEST_ACCOUNT.userId)}`, method: "dns" });
    expect(res.status).toBe(409);
    expect(await read(res)).toMatchObject({ error: "full", message: CLAIMS_TEXT.full });
  });
});

describe("check, start over and remove", () => {
  async function withClaim(o: Parameters<typeof setup>[0] = {}) {
    const s = await setup(o);
    const res = await s.create({ source: `analysis:${await analysisOf(s.d, "https://shop.example.com", TEST_ACCOUNT.userId)}`, method: "dns" });
    const body = await read(res);
    return { ...s, claimId: body.claim!.id, token: body.token! };
  }

  // Fails if another account can check, restart or remove a claim, or a malformed id is not a 404.
  it("another account's claim, an unknown and a malformed id are 404 for every action", async () => {
    const { claimId, other, check, startOver, remove, d } = await withClaim();
    for (const res of [await check(claimId, other), await startOver({ claimId }, other), await remove(claimId, other), await check("nope"), await check("00000000-0000-4000-8000-000000000000")]) {
      expect(res.status).toBe(404);
      expect((await read(res)).message).toBe(CLAIMS_TEXT.notFound);
    }
    expect(await d.accounts.listClaims(TEST_ACCOUNT.userId)).toHaveLength(1);
    expect((await check(claimId, "")).status).toBe(401);
  });

  // Fails if Check again does not record what it found, or a found record does not verify.
  it("Check again records the result and verifies when the record is there", async () => {
    const { claimId, token, check, records } = await withClaim();
    const first = await read(await check(claimId));
    expect(first.claim).toMatchObject({ status: "pending", reason: expect.stringContaining("found no TXT record at _retrofit-verification.shop.example.com") });
    expect(first.claim?.reason).toContain("can take time to appear");
    records.current = [[`retrofit-site-verification=${token}`]];
    const second = await read(await check(claimId));
    expect(second.claim).toMatchObject({ status: "verified", reason: "Retrofit found the record at _retrofit-verification.shop.example.com." });
  });

  // BE-M1. Fails if Check again during an outage ends a verified claim (and its published page), hides what it found, or a
  // later pass does not clear it.
  it("Check again on a verified claim shows a failure and never ends the claim", async () => {
    const clock = fakeClock(Date.parse("2026-11-23T10:00:00.000Z"));
    const { d, claimId, token, check, records } = await withClaim({ clock });
    records.current = [[`retrofit-site-verification=${token}`]];
    expect((await read(await check(claimId))).claim?.status).toBe("verified");
    records.current = [];
    clock.advance(60_000);
    for (let n = 0; n < 3; n++) {
      const failed = await read(await check(claimId));
      expect(failed.claim).toMatchObject({ status: "verified", reason: expect.stringContaining("found no TXT record"), lastChecked: expect.stringContaining("10:01 UTC") });
      expect(failed.message).toBe(failed.claim?.reason);
    }
    expect(await d.accounts.getClaim(TEST_ACCOUNT.userId, claimId)).toMatchObject({ status: "verified", failures: 0 });
    records.current = [[`retrofit-site-verification=${token}`]];
    expect((await read(await check(claimId))).claim).toMatchObject({ status: "verified", reason: expect.stringContaining("found the record") });
  });

  // Fails if a claim can be checked more than CLAIM_CHECKS_PER_HOUR times an hour (Start over included), or the 429 lacks the retry time.
  it(`allows ${CLAIM_CHECKS_PER_HOUR} checks per claim per hour, Start over included, then 429 with retryAt`, async () => {
    const clock = fakeClock(Date.parse("2026-11-23T10:20:00.000Z"));
    const { claimId, check, startOver } = await withClaim({ clock });
    expect((await startOver({ claimId })).status).toBe(200);
    for (let n = 1; n < CLAIM_CHECKS_PER_HOUR; n++) expect((await check(claimId)).status).toBe(200);
    const limited = await check(claimId);
    expect(limited.status).toBe(429);
    const body = await read(limited);
    expect(body).toMatchObject({ error: "limit", retryAt: "2026-11-23T11:00:00.000Z", message: CLAIMS_TEXT.limit(new Date("2026-11-23T11:00:00.000Z")) });
    expect(body.message).toMatch(/Try again at 11:00 UTC\.$/);
    expect((await startOver({ claimId })).status).toBe(429);
    clock.advance(3_600_000);
    expect((await check(claimId)).status).toBe(200);
  });

  // P3-R3. Fails if removing a claim and claiming the host again gives a fresh check budget.
  it("the check limit is per account and host: Remove and a new claim do not reset it", async () => {
    const clock = fakeClock(Date.parse("2026-11-23T10:20:00.000Z"));
    const { d, claimId, check, remove, create } = await withClaim({ clock });
    for (let n = 0; n < CLAIM_CHECKS_PER_HOUR; n++) expect((await check(claimId)).status).toBe(200);
    expect((await check(claimId)).status).toBe(429);
    expect((await remove(claimId)).status).toBe(200);
    const again = await read(await create({ source: `analysis:${await analysisOf(d, "https://shop.example.com", TEST_ACCOUNT.userId)}`, method: "dns" }));
    expect(again.claim?.id).not.toBe(claimId);
    const limited = await check(again.claim!.id);
    expect(limited.status).toBe(429);
    expect((await read(limited)).retryAt).toBe("2026-11-23T11:00:00.000Z");
  });

  // P3-R3. Fails if an account can create (or Start over) claims without an hourly bound, or the 429 lacks the retry time.
  it(`allows ${CLAIM_CHANGES_PER_HOUR} claim creations and Start overs per account per hour, then 429 with retryAt`, async () => {
    const clock = fakeClock(Date.parse("2026-11-23T10:20:00.000Z"));
    const { d, create, remove, startOver } = await setup({ clock });
    const source = `analysis:${await analysisOf(d, "https://cap.example.com", TEST_ACCOUNT.userId)}`;
    let last = "";
    for (let n = 0; n < CLAIM_CHANGES_PER_HOUR - 1; n++) {
      const body = await read(await create({ source, method: "dns" }));
      last = body.claim!.id;
      if (n < CLAIM_CHANGES_PER_HOUR - 2) await remove(last);
    }
    expect((await startOver({ claimId: last })).status).toBe(200);
    await remove(last);
    const refused = await create({ source, method: "dns" });
    expect(refused.status).toBe(429);
    expect(await read(refused)).toMatchObject({ error: "limit", retryAt: "2026-11-23T11:00:00.000Z", message: CLAIMS_TEXT.changeLimit(new Date("2026-11-23T11:00:00.000Z")) });
    clock.advance(3_600_000);
    expect((await create({ source, method: "dns" })).status).toBe(201);
  });

  // Fails if Start over keeps the old token, cannot switch the method, or works on a verified claim.
  it("Start over shows a new token once, can switch the method, and refuses a verified claim", async () => {
    const { claimId, token, startOver, check, records, d } = await withClaim();
    const res = await startOver({ claimId, method: "meta" });
    expect(res.status).toBe(200);
    const body = await read(res);
    expect(body.token).toMatch(/^[0-9a-f]{32}$/);
    expect(body.token).not.toBe(token);
    expect(body).toMatchObject({ message: CLAIMS_TEXT.restarted, claim: { method: "meta", status: "pending" } });
    expect((await d.accounts.getClaim(TEST_ACCOUNT.userId, claimId))?.tokenHash).toBe(sha256Hex(body.token!));
    await startOver({ claimId, method: "dns" }).then(read).then((b) => (records.current = [[`retrofit-site-verification=${b.token}`]]));
    expect((await read(await check(claimId))).claim?.status).toBe("verified");
    const refused = await startOver({ claimId });
    expect(refused.status).toBe(409);
    expect(await read(refused)).toMatchObject({ error: "verified", message: CLAIMS_TEXT.verifiedNoRestart });
  });

  // Fails if Remove leaves the claim or answers like a failure.
  it("Remove withdraws the claim", async () => {
    const { claimId, remove, d } = await withClaim();
    const res = await remove(claimId);
    expect(res.status).toBe(200);
    expect((await read(res)).message).toBe(CLAIMS_TEXT.removed);
    expect(await d.accounts.listClaims(TEST_ACCOUNT.userId)).toEqual([]);
    expect((await remove(claimId)).status).toBe(404);
  });

  // Fails if a failing account data store is not a 503 with the fallback text.
  it("answers 503 when the account data is unavailable", async () => {
    const { d, claimId } = await withClaim();
    const broken = { ...d, accounts: { ...d.accounts, getClaim: async () => Promise.reject(new Error("down")) } };
    const res = await handleCheckClaim(postRequest("/api/claims/check", { claimId }, { cookie: await accountCookie(d) }), broken);
    expect(res.status).toBe(503);
    expect((await read(res)).message).toBe(CLAIMS_TEXT.unavailable);
  });
});
