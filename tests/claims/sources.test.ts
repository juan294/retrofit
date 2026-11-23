/**
 * Where a claim's host comes from (src/lib/claims/sources.ts, src/lib/claims/host.ts): only an
 * analysis attached to the account or one of its saved reports, normalized to the exact host; and
 * the account's list of analyses that the account page offers.
 */
import { describe, expect, it } from "vitest";
import { attachVisitorAnalyses, listAccountAnalyses } from "@/lib/analysis/owner";
import { getAnalysis } from "@/lib/analysis/record";
import { handleAnalyze } from "@/lib/api/analyze";
import { claimHost, claimPageUrl, newClaimToken, FIXTURE_CLAIM_TOKEN } from "@/lib/claims/host";
import { claimOptions, parseClaimSource } from "@/lib/claims/sources";
import { loadConfig } from "@/lib/config";
import { sha256Hex } from "@/lib/security/tokens";
import { accountCookie, analyzeRequest, holdAllSlots, OTHER_ACCOUNT, testDeps, TEST_ACCOUNT } from "../helpers/server-deps";

describe("claimHost", () => {
  // Fails if a host is not normalized like URL.host (case, IDN, default port), or a value that is not a bare host passes.
  it.each([
    ["WWW.Shop.Example.com", "www.shop.example.com"],
    ["bücher.example", "xn--bcher-kva.example"],
    ["shop.example.com:443", "shop.example.com"],
    ["bakery.fixture.test:3011", "bakery.fixture.test:3011"],
  ])("claimHost(%j) -> %j", (raw, host) => {
    expect(claimHost(raw)).toBe(host);
  });

  it.each([[""], ["shop.example.com/path"], ["user@shop.example.com"], ["shop.example.com?x"], ["shop example.com"], ["a#b"], ["x".repeat(300)]])("claimHost(%j) -> null", (raw) => {
    expect(claimHost(raw)).toBeNull();
  });

  // Fails if the meta check reads anything but https://<host>/ outside fixtures, or a non-public host passes.
  it("the meta check reads https://<host>/, and http only for a fixture host in fixtures mode", () => {
    const prod = loadConfig({ SESSION_SECRET: "s".repeat(32) });
    const fixtures = loadConfig({ SESSION_SECRET: "s".repeat(32), RETROFIT_TEST_FIXTURES: "1" });
    expect(claimPageUrl("shop.example.com", prod).href).toBe("https://shop.example.com/");
    expect(claimPageUrl("bakery.fixture.test:3011", fixtures).href).toBe("http://bakery.fixture.test:3011/");
    expect(() => claimPageUrl("bakery.fixture.test:3011", prod)).toThrow();
    expect(() => claimPageUrl("10.0.0.1", prod)).toThrow();
    expect(() => claimPageUrl("localhost", prod)).toThrow();
  });

  // Fails if the fixed e2e token is ever used outside fixtures mode or for a real host, or the random token repeats.
  it("uses the fixture token only for fixture hosts in fixtures mode", () => {
    const prod = loadConfig({ SESSION_SECRET: "s".repeat(32) });
    const fixtures = loadConfig({ SESSION_SECRET: "s".repeat(32), RETROFIT_TEST_FIXTURES: "1" });
    expect(newClaimToken("bakery.fixture.test:3011", fixtures)).toBe(FIXTURE_CLAIM_TOKEN);
    expect(newClaimToken("bakery.fixture.test:3011", prod)).not.toBe(FIXTURE_CLAIM_TOKEN);
    expect(newClaimToken("shop.example.com", fixtures)).not.toBe(FIXTURE_CLAIM_TOKEN);
    expect(newClaimToken("shop.example.com", prod)).toMatch(/^[0-9a-f]{32}$/);
    expect(newClaimToken("shop.example.com", prod)).not.toBe(newClaimToken("shop.example.com", prod));
  });
});

describe("parseClaimSource", () => {
  // Fails if a typed host or a malformed id is accepted as a source.
  it("accepts only report:<uuid> and analysis:<32 hex>", () => {
    expect(parseClaimSource("report:00000000-0000-4000-8000-000000000001")).toEqual({ kind: "report", id: "00000000-0000-4000-8000-000000000001" });
    expect(parseClaimSource(`analysis:${"a".repeat(32)}`)).toEqual({ kind: "analysis", id: "a".repeat(32) });
    for (const bad of ["shop.example.com", "report:", "analysis:xyz", `host:${"a".repeat(32)}`, `analysis:${"A".repeat(32)}`, 42, null]) expect(parseClaimSource(bad)).toBeNull();
  });
});

describe("the account's analyses", () => {
  // Fails if an analysis started signed in is not listed for the account, or another account's appears.
  it("lists analyses started while signed in, newest first, and only the account's own", async () => {
    const d = testDeps();
    await holdAllSlots(d);
    const cookie = await accountCookie(d, TEST_ACCOUNT);
    const ids: string[] = [];
    for (const url of ["https://one.example.com", "https://two.example.com"]) {
      const res = await handleAnalyze(analyzeRequest({ url }, { cookie: `retrofit_visitor=${"c".repeat(32)}; ${cookie}` }), d);
      ids.push(((await res.json()) as { id: string }).id);
    }
    await handleAnalyze(analyzeRequest({ url: "https://other.example.com" }, { cookie: await accountCookie(d, OTHER_ACCOUNT) }), d);
    expect((await listAccountAnalyses(d, TEST_ACCOUNT.userId, 10)).map((a) => a.id)).toEqual([ids[1], ids[0]]);
    expect((await listAccountAnalyses(d, TEST_ACCOUNT.userId, 1)).map((a) => a.id)).toEqual([ids[1]]);
  });

  // Fails if analyses attached at sign-in are not listed for the account (the account page could not offer them).
  it("lists analyses attached at sign-in", async () => {
    const d = testDeps();
    await holdAllSlots(d);
    const visitor = "d".repeat(32);
    const res = await handleAnalyze(analyzeRequest({ url: "https://before.example.com" }, { cookie: `retrofit_visitor=${visitor}` }), d);
    const { id } = (await res.json()) as { id: string };
    expect(await listAccountAnalyses(d, TEST_ACCOUNT.userId, 10)).toEqual([]);
    expect(await attachVisitorAnalyses(d, sha256Hex(visitor), TEST_ACCOUNT.userId)).toBe(1);
    expect((await listAccountAnalyses(d, TEST_ACCOUNT.userId, 10)).map((a) => a.id)).toEqual([id]);
    expect((await getAnalysis(d.store, id))?.accountId).toBe(TEST_ACCOUNT.userId);
  });

  // Fails if the claim choices repeat a host, offer a host the account already claims, or miss saved reports.
  it("claimOptions offers each host once, recent analyses first, without the hosts already claimed", async () => {
    const d = testDeps();
    await holdAllSlots(d);
    const cookie = await accountCookie(d, TEST_ACCOUNT);
    for (const url of ["https://a.example.com", "https://b.example.com", "https://a.example.com"]) await handleAnalyze(analyzeRequest({ url }, { cookie }), d);
    const report = (host: string) => ({ host, report: { status: "ready", host }, fetchedAt: "2026-11-23T10:00:00.000Z" });
    for (const host of ["b.example.com", "c.example.com"]) await d.accounts.saveReport(TEST_ACCOUNT.userId, report(host));
    await d.accounts.createClaim(TEST_ACCOUNT.userId, { host: "b.example.com", method: "dns", tokenHash: sha256Hex("t") });
    const options = await claimOptions(d, TEST_ACCOUNT.userId, await d.accounts.listSavedReports(TEST_ACCOUNT.userId), await d.accounts.listClaims(TEST_ACCOUNT.userId));
    expect(options.map((o) => o.label)).toEqual(["a.example.com (recent analysis)", "c.example.com (saved report)"]);
    expect(options[0]?.value).toMatch(/^analysis:[0-9a-f]{32}$/);
    expect(options[1]?.value).toMatch(/^report:[0-9a-f-]{36}$/);
  });
});
