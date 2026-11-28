/**
 * Publish, refresh and unpublish (src/lib/api/publish.ts, src/lib/publish/publish.ts; parent success
 * criterion 5): a verified claim held by the account, the newest ready analysis of that exact scored
 * host, the vendored validator before any write, the hourly limit, and a failed refresh that keeps
 * the published snapshot and stores a code.
 */
import { describe, expect, it } from "vitest";
import type { AccountData, RefreshError } from "@/lib/accounts/data";
import { AccountDataUnavailable, MAX_PUBLISHED_SNAPSHOT_BYTES } from "@/lib/accounts/data";
import { PUBLISH_PER_HOUR, PUBLISH_TRIES_PER_HOUR } from "@/lib/accounts/limits";
import { handlePublish, handleUnpublish, type PublishDeps } from "@/lib/api/publish";
import type { PublishedView } from "@/lib/publish/view";
import { PUBLISH_TEXT } from "@/lib/site/publish-texts";
import { accountCookie, fakeClock, OTHER_ACCOUNT, postRequest, PUBLIC_ORIGIN, testDeps, TEST_ACCOUNT, type TestDeps } from "../helpers/server-deps";
import { HOST, lapseNow, listedAnalysis, OWNER, pendingClaim, publishDirect, snapshotOf, verifiedClaim, verifyNow } from "./setup";

type RefreshCase = [code: RefreshError, status: number, message: string, arrange: (d: TestDeps) => Promise<void>, over: Partial<PublishDeps>];
type Answer = { error?: string; message?: string; site?: PublishedView | null; retryAt?: string };
const read = async (res: Response) => ({ status: res.status, body: (await res.json()) as Answer });
const T1 = "2026-11-20T08:00:00.000Z";
const T2 = "2026-11-21T08:00:00.000Z";

async function setup(start = "2026-11-21T10:00:00.000Z") {
  const clock = fakeClock(Date.parse(start));
  const d = testDeps({ clock: clock.clock });
  const owner = await accountCookie(d, TEST_ACCOUNT);
  const other = await accountCookie(d, OTHER_ACCOUNT);
  const publish = async (o: { host?: unknown; cookie?: string; deps?: PublishDeps; extra?: object } = {}) =>
    read(await handlePublish(postRequest("/api/publish", { host: o.host === undefined ? HOST : o.host }, { cookie: o.cookie ?? owner, ...o.extra }), o.deps ?? d));
  const unpublish = async (o: { host?: unknown; cookie?: string; extra?: object } = {}) =>
    read(await handleUnpublish(postRequest("/api/publish/remove", { host: o.host === undefined ? HOST : o.host }, { cookie: o.cookie ?? owner, ...o.extra }), d));
  const text = async (host = HOST) => (await d.accounts.getPublicSnapshot(host))?.snapshot as { pages: { text: string }[] } | undefined;
  const marker = async () => (await text())?.pages[0]?.text ?? null;
  const error = async () => (await d.accounts.listPublishedSites(OWNER))[0]?.lastRefreshError;
  return { d, clock, owner, other, publish, unpublish, marker, error };
}

const cross = { fetchSite: "cross-site", origin: "https://evil.example" };

describe("POST /api/publish preconditions", () => {
  // Fails if publishing works from another site, signed out, with an oversized body or without an exact host name.
  it("refuses cross-origin (403), signed-out (401), too large (413) and invalid hosts (400)", async () => {
    const { d, publish, unpublish } = await setup();
    await verifiedClaim(d);
    await listedAnalysis(d, { snapshot: snapshotOf(HOST, T1) });
    for (const call of [publish, unpublish]) {
      expect(await call({ extra: cross })).toEqual({ status: 403, body: { error: "cross_origin", message: PUBLISH_TEXT.crossOrigin } });
      expect((await call({ cookie: "" })).status).toBe(401);
      expect((await call({ host: "x".repeat(4000) })).status).toBe(413);
      for (const host of ["", "SHOP.example.com", `https://${HOST}`, `${HOST}/`, `${HOST}:443`, "a b", 42, null]) {
        const r = await call({ host });
        expect(r.status, JSON.stringify(host)).toBe(400);
        expect(r.body).toEqual({ error: "invalid", message: PUBLISH_TEXT.invalid });
      }
    }
    expect(await d.accounts.listPublicHosts(10)).toEqual([]);
  });

  // Fails if an account can publish a host it holds no claim for (another account's included), or one whose claim is not verified now.
  it("needs the account's own verified claim: no claim 403; pending, lapsed and superseded 409", async () => {
    const { d, publish, other } = await setup();
    await listedAnalysis(d, { snapshot: snapshotOf(HOST, T1) });
    expect(await publish()).toEqual({ status: 403, body: { error: "not_yours", message: PUBLISH_TEXT.noClaim(HOST) } });
    const claim = await pendingClaim(d);
    expect(await publish()).toEqual({ status: 409, body: { error: "not_verified", message: PUBLISH_TEXT.notVerified(HOST) } });
    await verifyNow(d, claim);
    await listedAnalysis(d, { snapshot: snapshotOf(HOST, T1), accountId: OTHER_ACCOUNT.userId });
    expect((await publish({ cookie: other })).status).toBe(403);
    await lapseNow(d, claim);
    expect((await publish()).status).toBe(409);
    await verifiedClaim(d, OTHER_ACCOUNT.userId);
    expect((await d.accounts.getClaim(OWNER, claim.id))?.status).toBe("superseded");
    expect((await publish()).body.error).toBe("not_verified");
    expect(await d.accounts.listPublicHosts(10)).toEqual([]);
  });

  // Fails if the claim check is only made before the write: a claim that lapses in between must stop the publish.
  it("a claim that lapses between the check and the write is refused with 409", async () => {
    const { d, publish } = await setup();
    const claim = await verifiedClaim(d);
    await listedAnalysis(d, { snapshot: snapshotOf(HOST, T1) });
    const accounts: AccountData = {
      ...d.accounts,
      publishSite: async (id, input) => {
        await lapseNow(d, claim);
        return d.accounts.publishSite(id, input);
      },
    };
    expect(await publish({ deps: { ...d, accounts } })).toEqual({ status: 409, body: { error: "not_verified", message: PUBLISH_TEXT.notVerified(HOST) } });
    expect(await d.accounts.listPublishedSites(OWNER)).toEqual([]);
  });
});

describe("the analysis that is published", () => {
  // Fails if anything but a ready, unexpired analysis attached to the account for that exact scored host is published.
  it("without a ready analysis of the exact host attached to the account it answers 409 and says to analyze it first", async () => {
    const { d, publish } = await setup();
    await verifiedClaim(d);
    const none = { status: 409, body: { error: "no_analysis", message: PUBLISH_TEXT.refreshError.no_analysis(HOST) } };
    expect(await publish()).toEqual(none);
    expect(PUBLISH_TEXT.refreshError.no_analysis(HOST)).toMatch(/^Analyze shop\.example\.com first/);
    await listedAnalysis(d, { snapshot: snapshotOf("www.shop.example.com", T1) });
    // Typed as the claimed host, but the analysis scored another one.
    await listedAnalysis(d, { snapshot: snapshotOf("www.shop.example.com", T1), inputOrigin: `https://${HOST}`, listedHost: HOST });
    await listedAnalysis(d, { snapshot: snapshotOf(HOST, T1), over: { accountId: OTHER_ACCOUNT.userId } });
    await listedAnalysis(d, { snapshot: snapshotOf(HOST, T1), over: { expiresAt: d.clock() - 1 } });
    await listedAnalysis(d, {});
    expect(await publish()).toEqual(none);
    expect(await d.accounts.listPublishedSites(OWNER)).toEqual([]);
  });

  // Fails if the newest ready analysis is not the one published, an unready newer one blocks it, or the scored host is not what counts.
  it("publishes the newest ready analysis of the scored host, whatever was typed, and answers the page, the saved date and the snippet", async () => {
    const { d, clock, publish, marker } = await setup();
    const claim = await verifiedClaim(d);
    await listedAnalysis(d, { snapshot: snapshotOf(HOST, T1, "older"), over: { expiresAt: clock.now() + 1000 } });
    // Typed without www and redirected to the claimed host; the list still names the typed host.
    await listedAnalysis(d, { snapshot: snapshotOf(HOST, T2, "newest"), inputOrigin: "https://shop-typed.example.com", over: { expiresAt: clock.now() + 2000 } });
    await listedAnalysis(d, { over: { expiresAt: clock.now() + 3000 } });
    const { status, body } = await publish();
    expect(status).toBe(200);
    expect(body).toEqual({
      message: PUBLISH_TEXT.published,
      site: {
        host: HOST,
        url: `${PUBLIC_ORIGIN}/s/${HOST}`,
        savedOn: "21 November 2026",
        error: null,
        snippet: `<a href="${PUBLIC_ORIGIN}/s/${HOST}"><img src="${PUBLIC_ORIGIN}/badge/${HOST}.svg" alt="Agent-ready score by Retrofit"></a>`,
      },
    });
    expect(await marker()).toBe("newest");
    const [site] = await d.accounts.listPublishedSites(OWNER);
    expect(site).toMatchObject({ claimId: claim.id, fetchedAt: T2, publishedAt: "2026-11-21T10:00:00.000Z" });
    expect((await d.accounts.getPublicReport(HOST))?.report).toMatchObject({ status: "ready", scoreVersion: "score/v1", host: HOST, fetchedAt: T2 });
  });

  // P4-R3. Fails if the last started analysis wins over one with a newer read (it can use an older cached read of another typed address).
  it("among ready analyses of the host the newest read wins, not the last started", async () => {
    const { d, clock, publish, marker } = await setup();
    await verifiedClaim(d);
    await listedAnalysis(d, { snapshot: snapshotOf(HOST, T2, "newest read"), over: { expiresAt: clock.now() + 1000 } });
    for (let n = 2; n < 12; n++) await listedAnalysis(d, { snapshot: snapshotOf(HOST, T1, "older read"), over: { expiresAt: clock.now() + n * 1000 } });
    expect((await publish()).status).toBe(200);
    expect(await marker()).toBe("newest read");
  });

  // Fails if a network the vendored validator refuses is written, or page text reaches the answer.
  it("a network the validator refuses is not published (422), and nothing is stored", async () => {
    const { d, publish } = await setup();
    await verifiedClaim(d);
    await listedAnalysis(d, { snapshot: snapshotOf(HOST, T1) });
    expect(await publish({ deps: { ...d, validate: () => ["<b>validator text</b>"] } })).toEqual({ status: 422, body: { error: "generation_failed", message: PUBLISH_TEXT.refreshError.generation_failed(HOST) } });
    expect(await d.accounts.listPublishedSites(OWNER)).toEqual([]);
  });

  // Fails if a snapshot past the size limit is stored or answers an outage.
  it("a snapshot over the size limit is not published (422 too_large)", async () => {
    const { d, publish } = await setup();
    await verifiedClaim(d);
    await listedAnalysis(d, { snapshot: snapshotOf(HOST, T1, "x".repeat(MAX_PUBLISHED_SNAPSHOT_BYTES)) });
    expect(await publish()).toEqual({ status: 422, body: { error: "too_large", message: PUBLISH_TEXT.refreshError.too_large(HOST) } });
    expect(await d.accounts.listPublishedSites(OWNER)).toEqual([]);
  });
});

describe("refresh", () => {
  async function published() {
    const s = await setup();
    await verifiedClaim(s.d);
    await publishDirect(s.d, snapshotOf(HOST, T1, "published"));
    return s;
  }

  // Fails if a newer analysis does not replace the snapshot, the first publication time moves, or an old error stays.
  it("publishing again with a newer analysis replaces the snapshot and clears the last error", async () => {
    const { d, publish, marker, error } = await published();
    await d.accounts.recordRefreshError(OWNER, HOST, "generation_failed");
    await listedAnalysis(d, { snapshot: snapshotOf(HOST, T2, "refreshed") });
    const { status, body } = await publish();
    expect(status).toBe(200);
    expect(body).toMatchObject({ message: PUBLISH_TEXT.refreshed, site: { savedOn: "21 November 2026", error: null } });
    expect(await marker()).toBe("refreshed");
    expect(await error()).toBeNull();
  });

  // Fails if a failed refresh changes the public snapshot, stores anything but a code, or does not tell the owner why.
  it.each([
    ["no_analysis", 409, PUBLISH_TEXT.refreshError.no_analysis(HOST), async (_d: TestDeps) => {}, {}],
    ["generation_failed", 422, PUBLISH_TEXT.refreshError.generation_failed(HOST), async (d: TestDeps) => void (await listedAnalysis(d, { snapshot: snapshotOf(HOST, T2, "bad") })), { validate: () => ["page text <script>"] }],
    ["too_large", 422, PUBLISH_TEXT.refreshError.too_large(HOST), async (d: TestDeps) => void (await listedAnalysis(d, { snapshot: snapshotOf(HOST, T2, "y".repeat(MAX_PUBLISHED_SNAPSHOT_BYTES)) })), {}],
  ] satisfies RefreshCase[])("a refresh that fails with %s keeps the published snapshot and stores the code", async (code, status, message, arrange, over) => {
    const { d, publish, marker, error } = await published();
    await arrange(d);
    const r = await publish({ deps: { ...d, ...over } });
    expect(r.status).toBe(status);
    expect(r.body).toMatchObject({ error: code, message, site: { savedOn: "20 November 2026", error: PUBLISH_TEXT.refreshError[code](HOST) } });
    expect(await marker()).toBe("published");
    expect(await error()).toBe(code);
    expect(JSON.stringify(r.body)).not.toContain("<script>");
  });

  // The stuck state "Published refresh failed": the newest analysis of the site failed to crawl.
  it("after a failing crawl the refresh keeps the published snapshot, and the next ready analysis refreshes it", async () => {
    const { d, clock, publish, marker, error } = await published();
    await listedAnalysis(d, { snapshot: snapshotOf(HOST, T1, "published"), over: { expiresAt: clock.now() + 1000 } });
    await listedAnalysis(d, { over: { jobId: "failed-job", expiresAt: clock.now() + 2000 } });
    expect((await publish()).body.error).toBe("not_newer");
    expect(await marker()).toBe("published");
    expect(await error()).toBeNull();
    await listedAnalysis(d, { snapshot: snapshotOf(HOST, T2, "after the crawl worked"), over: { expiresAt: clock.now() + 3000 } });
    expect((await publish()).status).toBe(200);
    expect(await marker()).toBe("after the crawl worked");
    expect(await error()).toBeNull();
  });
});

// P4-R1, owner decision 2026-11-25: the verified owner gets a new read one hour after the last one (OWNER_REREAD_S), so a second
// analysis inside that hour brings no newer read.
describe("a refresh inside the owner's hour", () => {
  const READ = "2026-11-21T09:55:30.000Z";
  async function publishedFromRead() {
    const s = await setup("2026-11-21T10:00:00.000Z");
    await verifiedClaim(s.d);
    await listedAnalysis(s.d, { snapshot: snapshotOf(HOST, READ, "one read") });
    expect((await s.publish()).status).toBe(200);
    // A second analysis within the window copies the same read.
    s.clock.advance(60_000);
    await listedAnalysis(s.d, { snapshot: snapshotOf(HOST, READ, "one read") });
    return s;
  }

  // Fails if the owner is told only to analyze again (which cannot work yet), or the time is not when the cached read ends.
  it("says that one read is reused and from when a new one is possible, with the time as retryAt", async () => {
    const { publish, marker, d } = await publishedFromRead();
    const r = await publish();
    // The read ended at 09:55:30, so a new one is possible an hour later, shown as the next whole minute.
    const at = new Date("2026-11-21T10:56:00.000Z");
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: "not_newer", message: PUBLISH_TEXT.sameRead(HOST, 60, at), retryAt: at.toISOString(), site: { error: null } });
    expect(r.body.message).toMatch(/reads a site again for its verified owner 60 minutes after the last read.*10:56 UTC/);
    expect(await marker()).toBe("one read");
    expect((await d.accounts.listPublishedSites(OWNER))[0]?.lastRefreshError).toBeNull();
  });

  // Fails if a cache window shorter than the owner's hour is ignored (a new read is possible already when the cache ends).
  it("uses the configured window", async () => {
    const { d, publish } = await publishedFromRead();
    const deps = { ...d, config: { ...d.config, crawlCacheTtlS: 1800 } };
    const at = new Date("2026-11-21T10:26:00.000Z");
    expect((await publish({ deps })).body).toMatchObject({ message: PUBLISH_TEXT.sameRead(HOST, 30, at), retryAt: at.toISOString() });
  });

  // Fails if the answer counts as a failed refresh: it would overwrite a real error or use up the hourly limit.
  it("is not a failed refresh: it keeps an earlier error and does not count against the hourly limit", async () => {
    const { d, publish, error } = await publishedFromRead();
    await d.accounts.recordRefreshError(OWNER, HOST, "too_large");
    for (let n = 0; n < PUBLISH_PER_HOUR + 5; n++) expect((await publish()).status).toBe(409);
    expect(await error()).toBe("too_large");
    await listedAnalysis(d, { snapshot: snapshotOf(HOST, "2026-11-21T10:01:00.000Z", "a newer read") });
    expect((await publish()).status).toBe(200);
  });

  // Fails if a refresh after the window, from a new analysis, does not work, or without one still gives a past time.
  it("after the window it says to analyze again, and a new analysis refreshes the page", async () => {
    const { d, clock, publish, marker } = await publishedFromRead();
    clock.set(Date.parse("2026-11-21T10:56:00.000Z"));
    const r = await publish();
    expect(r.body).toMatchObject({ error: "not_newer", message: PUBLISH_TEXT.notNewer(HOST) });
    expect(r.body.retryAt).toBeUndefined();
    await listedAnalysis(d, { snapshot: snapshotOf(HOST, "2026-11-21T10:56:20.000Z", "a new read") });
    expect((await publish()).status).toBe(200);
    expect(await marker()).toBe("a new read");
  });

  // Fails if checking for a newer read is unlimited (each try reads the account's analyses).
  it(`answers 429 after ${PUBLISH_TRIES_PER_HOUR} tries in an hour`, async () => {
    const { publish } = await publishedFromRead();
    for (let n = 1; n < PUBLISH_TRIES_PER_HOUR; n++) expect((await publish()).status, String(n)).toBe(409);
    const r = await publish();
    expect(r).toEqual({ status: 429, body: { error: "limit", message: PUBLISH_TEXT.tries(new Date("2026-11-21T11:00:00.000Z")), retryAt: "2026-11-21T11:00:00.000Z" } });
  });
});

describe("limit and outages", () => {
  // Fails if publishing is not limited per account and hour, the answer has no retry time, or another account shares the window.
  it(`allows ${PUBLISH_PER_HOUR} publishes and refreshes per account and hour, then 429 with the retry time`, async () => {
    const { d, clock, publish, other } = await setup();
    await verifiedClaim(d);
    for (let n = 0; n < PUBLISH_PER_HOUR; n++) expect((await publish()).status).toBe(409);
    const r = await publish();
    expect(r.status).toBe(429);
    expect(r.body).toEqual({ error: "limit", message: PUBLISH_TEXT.limit(new Date("2026-11-21T11:00:00.000Z")), retryAt: "2026-11-21T11:00:00.000Z" });
    await verifiedClaim(d, OTHER_ACCOUNT.userId, "other.example.com");
    expect((await publish({ cookie: other, host: "other.example.com" })).status).toBe(409);
    clock.set(Date.parse("2026-11-21T11:00:01.000Z"));
    expect((await publish()).status).toBe(409);
  });

  // Fails if an account data outage looks like anything but 503, or leaks detail.
  it("answers 503 when the account data is unavailable", async () => {
    const { d, publish } = await setup();
    await verifiedClaim(d);
    await listedAnalysis(d, { snapshot: snapshotOf(HOST, T1) });
    const accounts: AccountData = { ...d.accounts, publishSite: async () => { throw new AccountDataUnavailable("publishSite", "request_failed"); } };
    expect(await publish({ deps: { ...d, accounts } })).toEqual({ status: 503, body: { error: "unavailable", message: PUBLISH_TEXT.unavailable } });
  });
});

describe("POST /api/publish/remove (unpublish)", () => {
  // Fails if unpublishing leaves the site public, works for another account, or removes the claim.
  it("removes only the account's own publication; the claim stays verified", async () => {
    const { d, unpublish, other } = await setup();
    const claim = await verifiedClaim(d);
    // `site: null`: an account page open in another tab drops its stale publication.
    expect(await unpublish()).toEqual({ status: 404, body: { error: "not_found", message: PUBLISH_TEXT.notPublished(HOST), site: null } });
    await publishDirect(d, snapshotOf(HOST, T1));
    expect((await unpublish({ cookie: other })).status).toBe(404);
    expect(await d.accounts.getPublicSite(HOST)).not.toBeNull();
    expect(await unpublish()).toEqual({ status: 200, body: { site: null, message: PUBLISH_TEXT.unpublished } });
    expect(await d.accounts.getPublicSite(HOST)).toBeNull();
    expect((await d.accounts.getClaim(OWNER, claim.id))?.status).toBe("verified");
  });

  // Fails if a paused publication cannot be removed while its claim is lapsed.
  it("removes a paused publication too", async () => {
    const { d, unpublish } = await setup();
    const claim = await verifiedClaim(d);
    await publishDirect(d, snapshotOf(HOST, T1));
    await lapseNow(d, claim);
    expect((await unpublish()).status).toBe(200);
    expect(await d.accounts.listPublishedSites(OWNER)).toEqual([]);
  });
});
