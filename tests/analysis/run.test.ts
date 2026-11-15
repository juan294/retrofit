import { afterEach, describe, expect, it } from "vitest";
import { getAnalysis } from "@/lib/analysis/record";
import { isSameOrigin, startAnalysis, withDefaultScheme } from "@/lib/analysis/run";
import { visitorFailure, visitorTexts } from "@/lib/analysis/texts";
import { handleAnalysisStatus } from "@/lib/api/status";
import { handleAnalyze } from "@/lib/api/analyze";
import { clientIdFor } from "@/lib/fetch/limits";
import { getJob } from "@/lib/crawl/jobs";
import { bakery, blocked } from "../fixtures/sites";
import { serveSites } from "../helpers/sites";
import { analyzeRequest, cookieFrom, fakeClock, holdAllSlots, PUBLIC_ORIGIN, statusRequest, testDeps } from "../helpers/server-deps";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

describe("startAnalysis", () => {
  // Fails if analyses are shared between visitors, or if each visitor starts its own crawl.
  it("gives two visitors different analysis ids and one shared job", async () => {
    const d = testDeps();
    await holdAllSlots(d);
    const a = await startAnalysis(d, { rawUrl: "https://bakery.example.com/menu", ownerHash: "a".repeat(64), clientId: "client-a" });
    const b = await startAnalysis(d, { rawUrl: "https://bakery.example.com/", ownerHash: "b".repeat(64), clientId: "client-b" });
    if (!a.ok || !b.ok) throw new Error("expected both analyses to start");
    expect(a.id).not.toBe(b.id);
    const ra = await getAnalysis(d.store, a.id);
    const rb = await getAnalysis(d.store, b.id);
    expect(ra?.ownerHash).toBe("a".repeat(64));
    expect(rb?.ownerHash).toBe("b".repeat(64));
    expect(ra?.jobId).toBe(rb?.jobId);
    expect((await getJob(d.store, ra!.jobId))?.inputOrigin).toBe("https://bakery.example.com");
  });

  // Fails if the per-client window is not enforced, is shared between clients, or loses the retry time.
  it("returns 429 with the retry time when the client limit is reached", async () => {
    const fc = fakeClock(Date.parse("2026-11-15T10:20:00.000Z"));
    const d = testDeps({ clock: fc.clock, env: { ANALYSES_PER_CLIENT_HOUR: "2" } });
    await holdAllSlots(d);
    const start = (host: string, clientId = "client-a") => startAnalysis(d, { rawUrl: `https://${host}`, ownerHash: "a".repeat(64), clientId });
    expect((await start("one.example.com")).ok).toBe(true);
    expect((await start("two.example.com")).ok).toBe(true);
    const third = await start("three.example.com");
    expect(third).toEqual({
      ok: false,
      status: 429,
      code: "client_limit",
      message: "You reached the limit of 2 analyses per hour. Try again at 11:00 UTC.",
      retryAt: "2026-11-15T11:00:00.000Z",
    });
    expect((await start("three.example.com", "client-b")).ok).toBe(true);
    fc.set(Date.parse("2026-11-15T11:00:01.000Z"));
    expect((await start("three.example.com")).ok).toBe(true);
  });

  // Fails if a NotPublicError is not mapped to 400 with the visitor text, or a refused URL writes an analysis.
  it("refuses an address that is not a public website with the visitor text", async () => {
    const d = testDeps();
    for (const raw of ["ftp://example.com", "https://user:pw@example.com", "https://10.0.0.1", "https://printer.local", "", "https://example.com:8080"]) {
      const r = await startAnalysis(d, { rawUrl: raw, ownerHash: "a".repeat(64), clientId: "c" });
      expect(r).toEqual({ ok: false, status: 400, code: "not_public", message: "This address is not a public website." });
    }
    expect([...d.backing.values.keys()].some((k) => k.startsWith("analysis:"))).toBe(false);
  });

  // Fails if the scheme rule from the score contract is not shared with the visitor route.
  it("adds https:// to an address with no scheme", async () => {
    expect(withDefaultScheme("  sunrisebakery.co.uk/menu ")).toBe("https://sunrisebakery.co.uk/menu");
    expect(withDefaultScheme("http://a.example")).toBe("http://a.example");
    expect(withDefaultScheme("localhost:3000")).toBe("https://localhost:3000");
    const d = testDeps();
    await holdAllSlots(d);
    const r = await startAnalysis(d, { rawUrl: "bakery.example.com", ownerHash: "a".repeat(64), clientId: "c" });
    if (!r.ok) throw new Error(r.message);
    expect((await getAnalysis(d.store, r.id))?.inputOrigin).toBe("https://bakery.example.com");
  });
});

describe("isSameOrigin", () => {
  const d = testDeps();
  const req = (h: Record<string, string>) => new Request(`${PUBLIC_ORIGIN}/api/analyze`, { method: "POST", headers: h });
  // Fails if either accepted signal is ignored, or a cross-site request passes.
  it("accepts Sec-Fetch-Site same-origin or Origin equal to PUBLIC_ORIGIN only", () => {
    expect(isSameOrigin(req({ "sec-fetch-site": "same-origin" }), d.config)).toBe(true);
    expect(isSameOrigin(req({ origin: PUBLIC_ORIGIN }), d.config)).toBe(true);
    expect(isSameOrigin(req({ "sec-fetch-site": "cross-site", origin: "https://evil.example" }), d.config)).toBe(false);
    expect(isSameOrigin(req({ "sec-fetch-site": "same-site" }), d.config)).toBe(false);
    expect(isSameOrigin(req({ origin: "https://retrofit.test.evil.example" }), d.config)).toBe(false);
    expect(isSameOrigin(req({}), d.config)).toBe(false);
  });
});

describe("visitor texts", () => {
  // Fails if any visitor text drifts from the parent plan's stuck-state table.
  it("match the parent plan's stuck-state table verbatim", () => {
    const at = new Date("2026-11-15T14:05:00.000Z");
    expect(visitorFailure("stale")).toBe("This analysis took too long. Try again.");
    expect(visitorFailure("robots_blocked")).toBe("This site asks automated tools not to read it. Retrofit stopped and read nothing else.");
    expect(visitorFailure("robots_unavailable", { retryAt: at })).toBe("Retrofit could not read this site's robots rules, so it stopped. Try again after 14:05 UTC.");
    expect(visitorFailure("not_public")).toBe("This address is not a public website.");
    expect(visitorFailure("queue_expired")).toBe("Retrofit is too busy right now. Try again in a few minutes.");
    expect(visitorFailure("daily_limit")).toBe("Retrofit reached today's analysis limit. Try again tomorrow.");
    expect(visitorFailure("crawl_error")).toBe("Retrofit could not read this site.");
    expect(visitorFailure("something_new")).toBe("Retrofit is having trouble. Try again in a few minutes.");
    expect(visitorTexts.queued).toBe("Retrofit is busy. Your analysis starts in a moment.");
    expect(visitorTexts.otherBrowser).toBe("This preview belongs to another browser. Analyze the site again to get your own.");
    expect(visitorTexts.clientLimit(20, at)).toBe("You reached the limit of 20 analyses per hour. Try again at 14:05 UTC.");
    expect(visitorTexts.expired(new Date("2026-11-22T10:20:00.000Z"))).toBe("This preview expired on 22 November 2026. Analyze the site again.");
  });

  // Fails if a crawl failure code reaches the visitor without its text (real robots-blocked crawl).
  it("maps a real robots_blocked failure to the visitor text in the status", async () => {
    const server = await serveSites(() => ({ "blocked.fixture.test": blocked, "bakery.fixture.test": bakery }));
    close = () => server.close();
    const d = testDeps();
    const res = await handleAnalyze(analyzeRequest({ url: server.origin("blocked.fixture.test") }), d);
    const { id } = (await res.json()) as { id: string };
    await d.settle();
    const status = await handleAnalysisStatus(statusRequest(id, { cookie: cookieFrom(res) }), d, id);
    expect(await status.json()).toEqual({
      status: "failed",
      step: "failed",
      failure: { code: "robots_blocked", message: "This site asks automated tools not to read it. Retrofit stopped and read nothing else." },
      scoreReady: false,
    });
    expect(d.errors).toEqual([]);
  });
});

describe("clientIdFor", () => {
  const d = testDeps();
  // Fails if the client id is the raw IP, ignores the daily salt or the secret.
  it("hashes the IP with a daily salt from SESSION_SECRET", () => {
    const day1 = Date.parse("2026-11-15T10:00:00.000Z");
    const id = clientIdFor("203.0.113.7", d.config, day1);
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(id).not.toContain("203.0.113.7");
    expect(clientIdFor("203.0.113.7", d.config, day1 + 3600_000)).toBe(id);
    expect(clientIdFor("203.0.113.7", d.config, day1 + 86_400_000)).not.toBe(id);
    expect(clientIdFor("203.0.113.8", d.config, day1)).not.toBe(id);
    expect(clientIdFor("203.0.113.7", { ...d.config, sessionSecret: "t".repeat(32) }, day1)).not.toBe(id);
  });
});
