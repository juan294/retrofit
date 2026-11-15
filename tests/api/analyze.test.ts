import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { getAnalysis } from "@/lib/analysis/record";
import { handleAnalysisStatus } from "@/lib/api/status";
import { handleAnalyze } from "@/lib/api/analyze";
import { getJob, updateJob, type CrawlJob } from "@/lib/crawl/jobs";
import { bakery } from "../fixtures/sites";
import { serveSites } from "../helpers/sites";
import { analyzeRequest, cookieFrom, fakeClock, holdAllSlots, PUBLIC_ORIGIN, statusRequest, storeDump, testDeps } from "../helpers/server-deps";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
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
      message: "You reached the limit of 2 analyses per hour. Try again at 11:00.",
      retryAt: "2026-11-15T11:00:00.000Z",
    });
    expect((await handleAnalyze(analyzeRequest({ url: "https://b.example.com" }, { ip: "203.0.113.78" }), d)).status).toBe(200);
    expect(storeDump(d.backing)).not.toContain(ip);
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
        message: "Retrofit could not read this site's robots rules, so it stopped. Try again after 11:20.",
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
