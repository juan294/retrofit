import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CRAWL_QUEUE } from "@/lib/analysis/capacity";
import { getAnalysis } from "@/lib/analysis/record";
import { handleAnalysisStatus } from "@/lib/api/status";
import { handleAnalyze } from "@/lib/api/analyze";
import { getJob, jobKey, leaseKey, OWNER_REREAD_S, startOrJoinCrawl, updateJob, type CrawlJob } from "@/lib/crawl/jobs";
import { shortHash, utcDay } from "@/lib/fetch/limits";
import { bakery } from "../fixtures/sites";
import { serveSites } from "../helpers/sites";
import { lapseNow, pendingClaim, verifiedClaim } from "../publish/setup";
import { accountCookie, analyzeRequest, captureConsole, cookieFrom, fakeClock, holdAllSlots, OTHER_ACCOUNT, PUBLIC_ORIGIN, statusRequest, storeDump, testDeps } from "../helpers/server-deps";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await close?.();
  close = undefined;
});

const OTHER_BROWSER = { error: "not_found", message: "This preview belongs to another browser. Analyze the site again to get your own." };

describe("POST /api/analyze", () => {
  // Fails if the same-origin precondition is skipped, or a refused request still writes an analysis.
  it("refuses a cross-origin POST with 403 and writes nothing", async () => {
    const d = testDeps();
    for (const o of [
      { fetchSite: "cross-site", origin: "https://evil.example" },
      { fetchSite: null, origin: "https://evil.example" },
      { fetchSite: null, origin: null },
    ]) {
      const res = await handleAnalyze(analyzeRequest({ url: "https://bakery.example.com" }, o), d);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "cross_origin", message: "Open Retrofit at its own address and paste the website address there." });
      expect(res.headers.get("set-cookie")).toBeNull();
    }
    expect(storeDump(d.backing)).not.toContain("analysis:");
  });

  // Fails if Origin equal to PUBLIC_ORIGIN (no Sec-Fetch-Site) is refused.
  it("accepts Origin equal to PUBLIC_ORIGIN", async () => {
    const d = testDeps();
    await holdAllSlots(d);
    const res = await handleAnalyze(analyzeRequest({ url: "https://bakery.example.com" }, { fetchSite: null, origin: PUBLIC_ORIGIN }), d);
    expect(res.status).toBe(200);
  });

  // Fails if any visitor cookie attribute is missing, the raw token is stored, or an existing cookie is replaced.
  it("sets the visitor cookie once and stores only its SHA-256", async () => {
    const d = testDeps();
    await holdAllSlots(d);
    const res = await handleAnalyze(analyzeRequest({ url: "https://bakery.example.com" }), d);
    expect(res.status).toBe(200);
    const raw = res.headers.get("set-cookie")!;
    const parts = raw.split(";").map((s) => s.trim());
    const token = (parts[0] as string).replace(/^retrofit_visitor=/, "");
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    expect(parts.slice(1).sort()).toEqual(["HttpOnly", "Max-Age=2592000", "Path=/", "SameSite=Lax", "Secure"]);
    const { id } = (await res.json()) as { id: string };
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect((await getAnalysis(d.store, id))?.ownerHash).toBe(createHash("sha256").update(token).digest("hex"));
    expect(storeDump(d.backing)).not.toContain(token);

    const again = await handleAnalyze(analyzeRequest({ url: "https://other.example.com" }, { cookie: cookieFrom(res) }), d);
    expect(again.headers.get("set-cookie")).toBeNull();
    const { id: id2 } = (await again.json()) as { id: string };
    expect((await getAnalysis(d.store, id2))?.ownerHash).toBe((await getAnalysis(d.store, id))?.ownerHash);
  });

  // Fails if Secure is set on a plain-http deployment (the cookie would never be sent back).
  it("omits Secure on http", async () => {
    const d = testDeps({ env: { PUBLIC_ORIGIN: "http://127.0.0.1:3010" } });
    await holdAllSlots(d);
    const req = new Request("http://127.0.0.1:3010/api/analyze", {
      method: "POST",
      headers: { "sec-fetch-site": "same-origin", "content-type": "application/json" },
      body: JSON.stringify({ url: "https://bakery.example.com" }),
    });
    const res = await handleAnalyze(req, d);
    expect(res.headers.get("set-cookie")).not.toMatch(/Secure/);
  });

  // Fails if the client limit is not applied on the visitor route, or the raw IP is stored.
  it("returns 429 with the retry time after ANALYSES_PER_CLIENT_HOUR analyses and never stores the IP", async () => {
    const fc = fakeClock(Date.parse("2026-11-15T10:20:00.000Z"));
    const d = testDeps({ clock: fc.clock, env: { ANALYSES_PER_CLIENT_HOUR: "2" } });
    await holdAllSlots(d);
    const ip = "203.0.113.77";
    expect((await handleAnalyze(analyzeRequest({ url: "https://a.example.com" }, { ip }), d)).status).toBe(200);
    expect((await handleAnalyze(analyzeRequest({ url: "https://a.example.com" }, { ip }), d)).status).toBe(200);
    const res = await handleAnalyze(analyzeRequest({ url: "https://b.example.com" }, { ip }), d);
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({
      error: "client_limit",
      message: "You reached the limit of 2 analyses per hour. Try again at 11:00 UTC.",
      retryAt: "2026-11-15T11:00:00.000Z",
    });
    expect((await handleAnalyze(analyzeRequest({ url: "https://b.example.com" }, { ip: "203.0.113.78" }), d)).status).toBe(200);
    expect(storeDump(d.backing)).not.toContain(ip);
  });

  // Validation V04. Fails if a visitor whose site's daily count is still undecided gets an analysis (a job
  // that could pass the daily cap), a daily_limit refusal, or a failure without a short retry.
  it("answers 503 counting with a 2 s retry and creates no analysis while the site's daily count is undecided", async () => {
    const fc = fakeClock(Date.parse("2026-11-15T10:20:00.000Z"));
    const d = testDeps({ clock: fc.clock });
    await holdAllSlots(d);
    const origin = "https://pending.example.com";
    await d.store.putIfAbsent(`crawl-origin-day:2026-11-15:${shortHash(origin)}`, { version: 1, state: "pending" }, 10);
    const res = await handleAnalyze(analyzeRequest({ url: origin }), d);
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("2");
    expect(await res.json()).toEqual({
      error: "counting",
      message: "Retrofit is still starting another analysis of this site. Try again in a few seconds.",
      retryAfterSeconds: 2,
    });
    expect(storeDump(d.backing)).not.toContain("analysis:");
    expect(await d.store.claimNext(CRAWL_QUEUE)).toBeNull();
  });

  // Fails if a malformed body or a non-public address is not refused with the visitor text.
  it("answers 400 with the visitor text for a bad body or address", async () => {
    const d = testDeps();
    for (const body of ["not json", { url: 42 }, {}, { url: "https://10.0.0.1" }]) {
      const res = await handleAnalyze(analyzeRequest(body), d);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "not_public", message: "This address is not a public website." });
    }
  });
});

describe("GET /api/analyze/[id]", () => {
  // Fails if the owner check is skipped, or a stranger can tell a real id from a made-up one.
  it("returns the same 404 text for another visitor's id, a missing cookie and a nonexistent id", async () => {
    const d = testDeps();
    await holdAllSlots(d);
    const a = await handleAnalyze(analyzeRequest({ url: "https://bakery.example.com" }), d);
    const b = await handleAnalyze(analyzeRequest({ url: "https://bakery.example.com" }), d);
    const { id } = (await a.json()) as { id: string };
    const cases = [
      await handleAnalysisStatus(statusRequest(id, { cookie: cookieFrom(b) }), d, id),
      await handleAnalysisStatus(statusRequest(id), d, id),
      await handleAnalysisStatus(statusRequest("f".repeat(32), { cookie: cookieFrom(a) }), d, "f".repeat(32)),
      await handleAnalysisStatus(statusRequest("../etc", { cookie: cookieFrom(a) }), d, "../etc"),
      await handleAnalysisStatus(statusRequest(id, { cookie: cookieFrom(b), include: "result" }), d, id),
    ];
    for (const res of cases) {
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual(OTHER_BROWSER);
    }
    const own = await handleAnalysisStatus(statusRequest(id, { cookie: cookieFrom(a) }), d, id);
    expect(own.status).toBe(200);
    expect(await own.json()).toEqual({ status: "queued", step: "queued", scoreReady: false });
  });

  // Fails if the status route reads the store more than once for the analysis and once for its job.
  it("makes one store read for the analysis and one for its job", async () => {
    let gets: string[] = [];
    const d = testDeps({ instrument: (op, key) => void (op === "get" && gets.push(key)) });
    await holdAllSlots(d);
    const res = await handleAnalyze(analyzeRequest({ url: "https://bakery.example.com" }), d);
    const { id } = (await res.json()) as { id: string };
    gets = [];
    await handleAnalysisStatus(statusRequest(id, { cookie: cookieFrom(res) }), d, id);
    await d.settle();
    expect(gets.map((k) => k.split(":")[0])).toEqual(["analysis", "crawl-job"]);
  });

  // Fails if the compact status grows past 2 KB or carries fields beyond {status, step, failure?, scoreReady}.
  it("keeps every status body under 2 KB with only the compact fields", async () => {
    const server = await serveSites(() => ({ "bakery.fixture.test": bakery }));
    close = () => server.close();
    const d = testDeps();
    const res = await handleAnalyze(analyzeRequest({ url: server.origin("bakery.fixture.test") }), d);
    const cookie = cookieFrom(res);
    const { id } = (await res.json()) as { id: string };
    await d.settle();
    const bodies: string[] = [];
    const ready = await handleAnalysisStatus(statusRequest(id, { cookie }), d, id);
    expect(ready.headers.get("cache-control")).toBe("no-store");
    bodies.push(await ready.text());

    // The longest failure text, with a retry time.
    await holdAllSlots(d);
    const res2 = await handleAnalyze(analyzeRequest({ url: "https://robots.example.com" }, { cookie }), d);
    const { id: id2 } = (await res2.json()) as { id: string };
    const job = (await getJob(d.store, (await getAnalysis(d.store, id2))!.jobId)) as CrawlJob;
    await updateJob(d, job, { status: "failed", step: "failed", failure: { code: "robots_unavailable", message: "x", retryAt: "2026-11-15T11:20:00.000Z" } });
    bodies.push(await (await handleAnalysisStatus(statusRequest(id2, { cookie }), d, id2)).text());

    for (const b of bodies) {
      expect(new TextEncoder().encode(b).length).toBeLessThanOrEqual(2048);
      const keys = Object.keys(JSON.parse(b) as object);
      expect(keys.every((k) => ["status", "step", "failure", "scoreReady"].includes(k))).toBe(true);
    }
    expect(JSON.parse(bodies[0] as string)).toEqual({ status: "ready", step: "ready", scoreReady: true });
    expect(JSON.parse(bodies[1] as string)).toEqual({
      status: "failed",
      step: "failed",
      failure: {
        code: "robots_unavailable",
        message: "Retrofit could not read this site's robots rules, so it stopped. Try again after 11:20 UTC.",
        retryAt: "2026-11-15T11:20:00.000Z",
      },
      scoreReady: false,
    });
  });

  // Fails if ?include=result does not return the analysis's report with cachedUntil, or returns it before it is ready.
  it("returns the score report with ?include=result once ready", async () => {
    const server = await serveSites(() => ({ "bakery.fixture.test": bakery }));
    close = () => server.close();
    const d = testDeps();
    const res = await handleAnalyze(analyzeRequest({ url: server.origin("bakery.fixture.test") }), d);
    const cookie = cookieFrom(res);
    const { id } = (await res.json()) as { id: string };
    await d.settle();
    const body = (await (await handleAnalysisStatus(statusRequest(id, { cookie, include: "result" }), d, id)).json()) as {
      status: string;
      report: { status: string; scoreVersion: string; fetchedAt: string; cachedUntil: string };
    };
    expect(body.status).toBe("ready");
    expect(body.report.status).toBe("ready");
    expect(body.report.scoreVersion).toBe("score/v1");
    const job = (await getJob(d.store, (await getAnalysis(d.store, id))!.jobId)) as CrawlJob;
    expect(body.report.cachedUntil).toBe(new Date(job.updatedAt + d.config.crawlCacheTtlS * 1000).toISOString());
  });
});

// Owner decision 2026-11-25: an analysis by the verified owner of the scored host does not reuse a read that is an hour old.
describe("a new read for the verified owner", () => {
  async function cachedRead() {
    const server = await serveSites(() => ({ "bakery.fixture.test": bakery }));
    close = () => server.close();
    const d = testDeps();
    const origin = server.origin("bakery.fixture.test");
    const host = new URL(origin).host;
    /** Analyzes the site and returns its crawl job, the read itself. */
    const analyze = async (cookie?: string) => {
      const res = await handleAnalyze(analyzeRequest({ url: origin }, { cookie }), d);
      expect(res.status).toBe(200);
      await d.settle();
      expect(d.errors).toEqual([]);
      const analysis = (await getAnalysis(d.store, ((await res.json()) as { id: string }).id))!;
      return (await getJob(d.store, analysis.jobId)) as CrawlJob;
    };
    const first = await analyze();
    expect(first).toMatchObject({ status: "ready", destinationHost: host });
    const aged = async (seconds: number) => d.store.set(jobKey(first.id), { ...first, updatedAt: first.updatedAt - seconds * 1000 }, 100_000);
    return { d, host, analyze, first, aged };
  }

  // Fails if the owner gets the old read, or the new one does not finish as its own read for every later visitor.
  it("reads the site again for the owner after an hour, and later visitors get that read", async () => {
    const { d, host, analyze, first, aged } = await cachedRead();
    await verifiedClaim(d, undefined, host);
    const owner = await accountCookie(d);
    expect((await analyze(owner)).id).toBe(first.id);
    await aged(OWNER_REREAD_S);
    const next = await analyze(owner);
    expect(next.id).not.toBe(first.id);
    expect(next).toMatchObject({ status: "ready", destinationHost: host, rereadHosts: [host] });
    expect((await analyze()).id).toBe(next.id);
    expect((await analyze(owner)).id).toBe(next.id);
  });

  // Fails if anybody but the account with a claim that is verified now can make Retrofit read the site again.
  it("keeps the cached read for visitors, other accounts, and a pending or lapsed claim", async () => {
    const { d, host, analyze, first, aged } = await cachedRead();
    await aged(OWNER_REREAD_S);
    const owner = await accountCookie(d);
    expect((await analyze(owner)).id).toBe(first.id);
    await pendingClaim(d, undefined, host);
    expect((await analyze(owner)).id).toBe(first.id);
    await verifiedClaim(d, undefined, "other.example");
    expect((await analyze(owner)).id).toBe(first.id);
    const claim = await verifiedClaim(d, undefined, host);
    const listClaims = vi.spyOn(d.accounts, "listClaims");
    expect((await analyze()).id).toBe(first.id);
    expect(listClaims).not.toHaveBeenCalled();
    expect((await analyze(await accountCookie(d, OTHER_ACCOUNT))).id).toBe(first.id);
    await lapseNow(d, claim);
    expect((await analyze(owner)).id).toBe(first.id);
  });

  // Fails if an owner's new read over the daily host cap costs every visitor the cached one.
  it("keeps the cached read for everybody when the daily host cap is full", async () => {
    const { d, host, analyze, first, aged } = await cachedRead();
    await verifiedClaim(d, undefined, host);
    await aged(OWNER_REREAD_S);
    // The site was counted on an earlier day, and today's cap is used.
    for (const key of [...d.backing.values.keys()]) if (key.startsWith("crawl-origin-day:")) d.backing.values.delete(key);
    const day = utcDay(d.clock());
    for (let n = 0; n < d.config.crawlMaxHostsPerDay; n++) await d.store.incrementWindow(`crawl-origins:${day}`, 86_400);
    expect((await analyze(await accountCookie(d))).id).toBe(first.id);
    expect((await analyze()).id).toBe(first.id);
  });

  // Fails if an outage of the account data stops the owner's analysis instead of giving the cached read.
  it("gives the cached read when the claims cannot be read", async () => {
    const { d, analyze, first, aged } = await cachedRead();
    await aged(OWNER_REREAD_S);
    const owner = await accountCookie(d);
    const lines: string[] = [];
    captureConsole(lines);
    vi.spyOn(d.accounts, "listClaims").mockRejectedValue(new Error("down"));
    expect((await analyze(owner)).id).toBe(first.id);
    expect(lines.join("\n")).toContain("Reading the claims of an analysis start failed: Error");
  });
});

describe("review fixes", () => {
  // P3-R4a. Fails if the status read follows a join in the same request (3 reads), or does not move
  // the analysis to the joined job so the next read is 2 reads.
  it("reports a joined job as running without following it, then reads the joined job next time", async () => {
    let gets: string[] = [];
    const d = testDeps({ instrument: (op, key) => void (op === "get" && gets.push(key.split(":")[0] as string)) });
    await holdAllSlots(d);
    const res = await handleAnalyze(analyzeRequest({ url: "https://converge-a.example.com" }), d);
    const cookie = cookieFrom(res);
    const { id } = (await res.json()) as { id: string };
    const joinerId = (await getAnalysis(d.store, id))!.jobId;
    const owner = await startOrJoinCrawl(d, "https://dest.example.com");
    const ownerJob = (await getJob(d.store, owner.jobId)) as CrawlJob;
    await updateJob(d, ownerJob, { status: "crawling", step: "page 2", leaseExpiresAt: d.clock() + 60_000 });
    await updateJob(d, (await getJob(d.store, joinerId)) as CrawlJob, { status: "joined", step: "joined", joinedTo: owner.jobId });

    gets = [];
    const first = await handleAnalysisStatus(statusRequest(id, { cookie }), d, id);
    expect(await first.json()).toEqual({ status: "crawling", step: "joined", scoreReady: false });
    expect(gets).toEqual(["analysis", "crawl-job"]);
    expect((await getAnalysis(d.store, id))?.jobId).toBe(owner.jobId);

    gets = [];
    const second = await handleAnalysisStatus(statusRequest(id, { cookie }), d, id);
    expect(await second.json()).toEqual({ status: "crawling", step: "page 2", scoreReady: false });
    expect(gets).toEqual(["analysis", "crawl-job"]);
  });

  // V01. Fails if the reader that loses the compare-and-set copying a ready job's result answers
  // ready without a score (the page then stopped polling and showed "Reading the site" forever).
  it("gives two tabs that read the first completed result at once the score and the report", async () => {
    const server = await serveSites(() => ({ "bakery.fixture.test": bakery }));
    close = () => server.close();
    const d = testDeps();
    const res = await handleAnalyze(analyzeRequest({ url: server.origin("bakery.fixture.test") }), d);
    const cookie = cookieFrom(res);
    const { id } = (await res.json()) as { id: string };
    await d.settle();
    expect((await getAnalysis(d.store, id))?.snapshot).toBeUndefined();
    const compact = await Promise.all([0, 1].map(async () => (await handleAnalysisStatus(statusRequest(id, { cookie }), d, id)).json()));
    for (const b of compact) expect(b).toEqual({ status: "ready", step: "ready", scoreReady: true });

    const again = await handleAnalyze(analyzeRequest({ url: server.origin("bakery.fixture.test") }, { cookie }), d);
    const { id: id2 } = (await again.json()) as { id: string };
    await d.settle();
    const full = await Promise.all([0, 1].map(async () => (await handleAnalysisStatus(statusRequest(id2, { cookie, include: "result" }), d, id2)).json()));
    for (const b of full as { scoreReady: boolean; report: { status: string } | null }[]) {
      expect(b.scoreReady).toBe(true);
      expect(b.report?.status).toBe("ready");
    }
    await d.settle();
  });

  // P3-R4b. Fails if a status read that loses the stale-marking race re-reads the job (jobs.ts).
  it("does not re-read the job after losing the race to mark it stale", async () => {
    const fc = fakeClock();
    let gets = 0;
    const d = testDeps({ clock: fc.clock, instrument: (op, key) => void (op === "get" && key.startsWith("crawl-job:") && gets++) });
    await holdAllSlots(d);
    const res = await handleAnalyze(analyzeRequest({ url: "https://slow.example.com" }), d);
    const cookie = cookieFrom(res);
    const { id } = (await res.json()) as { id: string };
    const jobId = (await getAnalysis(d.store, id))!.jobId;
    await d.store.acquireLease(leaseKey(jobId), 60);
    await updateJob(d, (await getJob(d.store, jobId)) as CrawlJob, { status: "crawling", step: "home", leaseExpiresAt: fc.now() + 60_000 });
    fc.advance(91_000);
    gets = 0;
    // Two readers at once: both see the stale job, one wins the compare-and-set.
    const bodies = await Promise.all([0, 1].map(async () => (await handleAnalysisStatus(statusRequest(id, { cookie }), d, id)).json()));
    for (const b of bodies) expect(b).toEqual({ status: "failed", step: "failed", failure: { code: "stale", message: "This analysis took too long. Try again." }, scoreReady: false });
    expect(gets).toBe(2);
    expect((await getJob(d.store, jobId))?.failure?.code).toBe("stale");
  });

  // Minor. Fails if a body over 8 KB is read whole or accepted, with or without an honest Content-Length.
  it("refuses a body over 8 KB with 413", async () => {
    const d = testDeps();
    const big = JSON.stringify({ url: `https://example.com/${"a".repeat(9000)}` });
    const undeclared = analyzeRequest(big);
    const honest = analyzeRequest(big);
    honest.headers.set("content-length", String(big.length));
    for (const req of [undeclared, honest]) {
      const res = await handleAnalyze(req, d);
      expect(res.status).toBe(413);
      expect(await res.json()).toEqual({ error: "too_large", message: "Send only the website address." });
    }
    const lying = analyzeRequest(big);
    lying.headers.set("content-length", "10");
    expect((await handleAnalyze(lying, d)).status).toBe(413);
  });

  // R2. Fails if a response with an HH:MM text lacks retryAt, or the text does not say UTC.
  it("sends retryAt with every HH:MM text", async () => {
    const fc = fakeClock(Date.parse("2026-11-15T10:20:00.000Z"));
    const d = testDeps({ clock: fc.clock, env: { ANALYSES_PER_CLIENT_HOUR: "1" } });
    await holdAllSlots(d);
    await handleAnalyze(analyzeRequest({ url: "https://a.example.com" }), d);
    const body = (await (await handleAnalyze(analyzeRequest({ url: "https://b.example.com" }), d)).json()) as { message: string; retryAt?: string };
    expect(body.message).toMatch(/\d\d:\d\d UTC\.$/);
    expect(body.retryAt).toBe("2026-11-15T11:00:00.000Z");
  });
});
