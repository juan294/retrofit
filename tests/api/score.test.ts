import { afterEach, describe, expect, it } from "vitest";
import { slotKey } from "@/lib/analysis/capacity";
import { codeForNotPublicReason, handleScore } from "@/lib/api/score";
import { getJob, originAliasKey, resolveJob, updateJob, type CrawlJob } from "@/lib/crawl/jobs";
import { robotsKey } from "@/lib/fetch/robots";
import { createMemoryStore } from "@/lib/store/memory";
import type { Store } from "@/lib/store/types";
import { bakery, blocked, type FixtureSite } from "../fixtures/sites";
import { serveSites } from "../helpers/sites";
import { scoreSnapshot } from "@/lib/score/score";
import type { Snapshot } from "@/lib/snapshot/types";
import { fakeClock, holdAllSlots, PUBLIC_ORIGIN, scoreRequest, storeDump, testDeps, type TestDeps } from "../helpers/server-deps";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

const MESSAGES = {
  missing_url: "Add the website address in the url query parameter, such as /api/score?url=https%3A%2F%2Fexample.com.",
  invalid_url:
    "The url is not a website address. Pass one public http or https address, such as https://example.com, with no user name or password and at most 2048 characters.",
  not_public:
    "This address is not a public website. Retrofit scores only public sites on the standard ports, not IP addresses, local names or private networks, and the name must exist in DNS. Check the spelling with the user or ask for another address.",
  robots_blocked:
    "This site asks automated tools not to read it. Retrofit stopped and read nothing else. Do not call again for this site. Its owner can allow RetrofitBot in robots.txt.",
  crawl_error:
    "Retrofit could not read this site. It did not answer in time, redirected too many times or refused the connection. Check that the address opens in a browser. If the site works only over http, call again once with an address that starts with http://.",
  stale: "This score took too long. Call again now with the same URL to start a new one.",
  unavailable: "Retrofit is having trouble. Try again in a few minutes.",
  method_not_allowed: "Use GET /api/score with the website address in the url query parameter.",
};
const RUNNING = { status: "running", retryAfterSeconds: 20, message: "The score is still running. Call again in 20 seconds with the same URL." };

/** Every response any test here produced, for the contract-wide header and leak checks. */
const seen: { status: number; headers: Headers; body: string }[] = [];
async function call(d: TestDeps, query: string, o: { method?: string; ip?: string; cookie?: string } = {}) {
  const res = await handleScore(scoreRequest(query, o), d);
  const body = await res.text();
  seen.push({ status: res.status, headers: res.headers, body });
  return { status: res.status, headers: res.headers, json: body ? (JSON.parse(body) as Record<string, unknown>) : null, body };
}
const q = (url: string) => `?url=${encodeURIComponent(url)}`;
const err = (error: keyof typeof MESSAGES) => ({ status: "error", error, message: MESSAGES[error] });

describe("GET /api/score validation (contract rules 1 to 4)", () => {
  // Fails if a missing, empty or blank url is not 400 missing_url, or a repeated url is accepted.
  it("answers 400 missing_url and invalid_url for absent, blank and repeated url", async () => {
    const d = testDeps();
    for (const query of ["", "?url=", "?url=%20%20", "?other=1"]) expect(await call(d, query)).toMatchObject({ status: 400, json: err("missing_url") });
    expect(await call(d, "?url=https%3A%2F%2Fa.example.com&url=https%3A%2F%2Fb.example.com")).toMatchObject({ status: 400, json: err("invalid_url") });
  });

  // Fails if any NotPublicError reason maps to the wrong error code (gap 6: string mapping, one test per reason).
  it.each([
    ["empty", "missing_url"],
    ["too long", "invalid_url"],
    ["not a URL", "invalid_url"],
    ["scheme", "invalid_url"],
    ["credentials", "invalid_url"],
    ["port", "not_public"],
    ["IP literal", "not_public"],
    ["no public suffix", "not_public"],
  ])("maps NotPublicError reason %j to %s", (reason, code) => {
    expect(codeForNotPublicReason(reason)).toBe(code);
  });

  // Fails if a reason string that validateUrl produces is not reached through the route with its code.
  it.each([
    ["too long", `https://example.com/${"a".repeat(2049)}`, "invalid_url"],
    ["not a URL", "https://exa mple.com", "invalid_url"],
    ["scheme", "ftp://example.com", "invalid_url"],
    ["credentials", "https://user:pw@example.com", "invalid_url"],
    ["port", "https://example.com:8080", "not_public"],
    ["port, after the https:// prefix", "localhost:3000", "not_public"],
    ["IP literal", "https://10.0.0.1", "not_public"],
    ["IP literal (http)", "http://127.0.0.1", "not_public"],
    ["no public suffix", "https://printer.local", "not_public"],
  ])("answers 400 for reason %s", async (_reason, url, code) => {
    const d = testDeps({ env: { RETROFIT_TEST_FIXTURES: "" } });
    expect(await call(d, q(url))).toMatchObject({ status: 400, json: err(code as keyof typeof MESSAGES) });
    expect(storeDump(d.backing)).not.toContain("crawl-job:");
  });

  // Fails if a name that resolves to a private address is not refused as not_public by the crawl.
  it("answers 400 not_public when the name resolves to a private address", async () => {
    const d = testDeps({ env: { RETROFIT_TEST_FIXTURES: "", SCORE_WAIT_MS: "3000" } });
    expect(await call(d, q("https://resolves-private.example.com"))).toMatchObject({ status: 400, json: err("not_public") });
    await d.settle();
  });

  // Fails if an address with no scheme is not treated as https://, or makes a second job (E28).
  it("treats bakery.example.com as https://bakery.example.com and joins the same job", async () => {
    const d = testDeps({ env: { SCORE_WAIT_MS: "1" } });
    await holdAllSlots(d);
    expect(await call(d, q("bakery.example.com/menu?x=1"))).toMatchObject({ status: 202, json: RUNNING });
    const alias = await d.store.get<{ jobId: string }>(originAliasKey("https://bakery.example.com"));
    expect(alias).not.toBeNull();
    expect(await call(d, q("https://bakery.example.com"))).toMatchObject({ status: 202 });
    expect((await d.store.get<{ jobId: string }>(originAliasKey("https://bakery.example.com")))?.jobId).toBe(alias?.jobId);
    expect([...d.backing.values.keys()].filter((k) => k.startsWith("crawl-job:"))).toHaveLength(1);
  });

  // Fails if a method other than GET or OPTIONS is served, or OPTIONS is not 204 with the allowed method.
  it("answers OPTIONS with 204 and other methods with 405", async () => {
    const d = testDeps();
    const options = await call(d, "", { method: "OPTIONS" });
    expect(options.status).toBe(204);
    expect(options.headers.get("access-control-allow-methods")).toBe("GET");
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      expect(await call(d, q("https://bakery.example.com"), { method })).toMatchObject({ status: 405, json: err("method_not_allowed") });
    }
    expect(storeDump(d.backing)).not.toContain("crawl-job:");
  });
});

describe("GET /api/score results (contract rules 7 to 10)", () => {
  // Fails if a ready job is not returned as the report with status ready and cachedUntil = updatedAt + CRAWL_CACHE_TTL_S.
  it("returns 200 with the score report", async () => {
    const server = await serveSites(() => ({ "bakery.fixture.test": bakery }));
    close = () => server.close();
    const d = testDeps({ env: { SCORE_WAIT_MS: "5000" } });
    const origin = server.origin("bakery.fixture.test");
    const res = await call(d, q(origin));
    expect(res.status).toBe(200);
    const alias = await d.store.get<{ jobId: string }>(originAliasKey(origin));
    const job = (await resolveJob(d.store, alias!.jobId)) as CrawlJob;
    expect(res.json).toEqual({
      ...scoreSnapshot(job.snapshot as Snapshot),
      status: "ready",
      cachedUntil: new Date(job.updatedAt + d.config.crawlCacheTtlS * 1000).toISOString(),
    });
    expect(Object.keys(res.json!)[0]).toBe("status");
    expect(res.headers.get("retry-after")).toBeNull();
    await d.settle();
  });

  // Fails if a job still running when SCORE_WAIT_MS ends is not 202 with the fixed body and Retry-After.
  it("returns 202 with the running body while the job is queued", async () => {
    const d = testDeps({ env: { SCORE_WAIT_MS: "1" } });
    await holdAllSlots(d);
    const res = await call(d, q("https://bakery.example.com"));
    expect(res).toMatchObject({ status: 202, json: RUNNING });
    expect(res.headers.get("retry-after")).toBe("20");
  });

  // Fails if robots refusal is not 422 robots_blocked.
  it("returns 422 robots_blocked for a site that disallows RetrofitBot", async () => {
    const server = await serveSites(() => ({ "blocked.fixture.test": blocked }));
    close = () => server.close();
    const d = testDeps({ env: { SCORE_WAIT_MS: "5000" } });
    expect(await call(d, q(server.origin("blocked.fixture.test")))).toMatchObject({ status: 422, json: err("robots_blocked") });
    await d.settle();
  });

  // Fails if unreadable robots rules do not give 503 with the retry time in seconds, Retry-After, HH:MM UTC and minutes (E29).
  it("returns 503 robots_unavailable with retryAfterSeconds 2220 when the retry time is 37 minutes ahead", async () => {
    const server = await serveSites(() => ({ "robots.fixture.test": { ...bakery, "/robots.txt": { status: 503, body: "down" } } }));
    close = () => server.close();
    const fc = fakeClock(Date.parse("2026-11-15T10:20:00.000Z"));
    const d = testDeps({ clock: fc.clock, sleep: async (ms) => void (await new Promise((r) => setTimeout(r, Math.min(ms, 20)))), env: { SCORE_WAIT_MS: "5000" } });
    const origin = server.origin("robots.fixture.test");
    // Robots rules failed 23 minutes ago and are cached as unavailable until 10:57 UTC.
    await d.store.set(robotsKey(origin), { kind: "unavailable", retryAt: Date.parse("2026-11-15T10:57:00.000Z") }, 3600);
    const res = await call(d, q(origin));
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("2220");
    expect(res.json).toEqual({
      status: "error",
      error: "robots_unavailable",
      message: "Retrofit could not read this site's robots rules, so it stopped. Call again after 10:57 UTC (in 37 minutes) with the same URL.",
      retryAfterSeconds: 2220,
      retryAt: "2026-11-15T10:57:00.000Z",
    });
    await d.settle();
  });

  // Fails if a real robots 5xx does not reach the agent as robots_unavailable.
  it("returns 503 robots_unavailable for a robots.txt 5xx", async () => {
    const server = await serveSites(() => ({ "robots.fixture.test": { ...bakery, "/robots.txt": { status: 500, body: "down" } } }));
    close = () => server.close();
    const d = testDeps({ env: { SCORE_WAIT_MS: "5000" } });
    const res = await call(d, q(server.origin("robots.fixture.test")));
    expect(res.status).toBe(503);
    expect(res.json?.error).toBe("robots_unavailable");
    expect(res.json?.retryAfterSeconds).toBeGreaterThan(3590);
    expect(res.json?.retryAfterSeconds).toBeLessThanOrEqual(3600);
    await d.settle();
  });

  // Fails if a redirect loop (or another unreadable site) is not 502 crawl_error.
  it("returns 502 crawl_error when the home page redirects in a loop", async () => {
    const loop: FixtureSite = { "/robots.txt": { headers: { "content-type": "text/plain" }, body: "User-agent: *\nAllow: /\n" }, "/": { status: 302, headers: { location: "/" } } };
    const server = await serveSites(() => ({ "loop.fixture.test": loop }));
    close = () => server.close();
    const d = testDeps({ env: { SCORE_WAIT_MS: "5000" } });
    expect(await call(d, q(server.origin("loop.fixture.test")))).toMatchObject({ status: 502, json: err("crawl_error") });
    await d.settle();
  });

  // Fails if a job that goes stale during the wait is not 503 stale with retryAfterSeconds 0, or the next call reuses it (E34).
  it("returns 503 stale with retryAfterSeconds 0, and the next call starts a new job", async () => {
    const fc = fakeClock();
    const d = testDeps({ clock: fc.clock, sleep: async (ms) => fc.advance(ms) });
    await holdAllSlots(d);
    const url = q("https://slow.example.com");
    expect((await call(d, url)).status).toBe(202);
    const jobId = (await d.store.get<{ jobId: string }>(originAliasKey("https://slow.example.com")))!.jobId;
    // A worker started the job and stopped; its 60 s lease ended. 70 s after its last write the job still counts as running.
    fc.advance(-d.config.scoreWaitMs);
    const crawling = await updateJob(d, (await getJob(d.store, jobId)) as CrawlJob, { status: "crawling", step: "home", leaseExpiresAt: fc.now() + 60_000 });
    expect(crawling).not.toBeNull();
    fc.advance(70_000);
    const res = await call(d, url);
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("0");
    expect(res.json).toEqual({ ...err("stale"), retryAfterSeconds: 0 });
    expect((await call(d, url)).status).toBe(202);
    expect((await d.store.get<{ jobId: string }>(originAliasKey("https://slow.example.com")))!.jobId).not.toBe(jobId);
  });

  // Fails if a store failure escapes as a 500 or an uncaught error instead of 503 unavailable.
  it("returns 503 unavailable when the store fails", async () => {
    const base = createMemoryStore();
    const failing = new Proxy(base, {
      get(target, prop) {
        if (prop === "get" || prop === "putIfAbsent") return () => Promise.reject(new Error("store down"));
        return target[prop as keyof Store];
      },
    }) as Store;
    const d = testDeps({ store: failing });
    const res = await call(d, q("https://bakery.example.com"));
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("120");
    expect(res.json).toEqual({ ...err("unavailable"), retryAfterSeconds: 120 });
  });

  // Fails if rule 10 is skipped: a report that names a Retrofit /r/ or /p/ path, or is over 16 KB, must not be sent.
  it("refuses to send a report with a Retrofit preview path or over 16 KB", async () => {
    const server = await serveSites(() => ({ "bakery.fixture.test": bakery }));
    close = () => server.close();
    for (const evil of [`${PUBLIC_ORIGIN}/r/0123456789abcdef0123456789abcdef`, `${PUBLIC_ORIGIN}/p/0123456789abcdef0123456789abcdef/x`, "y".repeat(17_000)]) {
      const d = testDeps({ env: { SCORE_WAIT_MS: "5000" }, score: (s) => ({ ...scoreSnapshot(s), summary: evil }) });
      expect(await call(d, q(server.origin("bakery.fixture.test")))).toMatchObject({ status: 503, json: { ...err("unavailable"), retryAfterSeconds: 120 } });
      await d.settle();
    }
  });
});

describe("GET /api/score client limit (contract rule 6)", () => {
  // Fails if repeat calls for one origin count against the limit, or new origins past the limit are not refused.
  it("counts each origin once per client per window", async () => {
    const fc = fakeClock(Date.parse("2026-11-15T10:20:00.000Z"));
    const d = testDeps({ clock: fc.clock, sleep: async (ms) => fc.advance(ms), env: { ANALYSES_PER_CLIENT_HOUR: "2", SCORE_WAIT_MS: "1" } });
    await holdAllSlots(d);
    for (let i = 0; i < 5; i++) expect((await call(d, q("https://a.example.com"))).status).toBe(202);
    expect((await call(d, q("https://b.example.com"))).status).toBe(202);
    const limited = await call(d, q("https://c.example.com"));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("2400");
    expect(limited.json).toEqual({
      status: "error",
      error: "client_limit",
      message: "This client reached the limit of 2 site scores per hour. Call again after 11:00 UTC (in 40 minutes).",
      retryAfterSeconds: 2400,
      retryAt: "2026-11-15T11:00:00.000Z",
    });
    // Still refused on a repeat: the refused origin was not marked as counted.
    expect((await call(d, q("https://c.example.com"))).status).toBe(429);
    // Origins already counted in this window still answer.
    expect((await call(d, q("https://a.example.com"))).status).toBe(202);
    // Another client is not limited.
    expect((await call(d, q("https://c.example.com"), { ip: "198.51.100.10" })).status).toBe(202);
    expect(storeDump(d.backing)).not.toContain("198.51.100");
  });
});

describe("GET /api/score headers and privacy (contract E33)", () => {
  // Fails if any response misses CORS, Cache-Control or Content-Type, sets a cookie, or names an analysis or preview.
  it("sends CORS *, no-store and JSON on every status, and never a cookie or analysis id", async () => {
    const d = testDeps({ env: { SCORE_WAIT_MS: "1" } });
    await holdAllSlots(d);
    await call(d, q("https://bakery.example.com"), { cookie: "retrofit_visitor=0123456789abcdef0123456789abcdef" });
    expect(storeDump(d.backing)).not.toContain("analysis:");
    expect(seen.length).toBeGreaterThan(20);
    const statuses = new Set(seen.map((s) => s.status));
    for (const s of [200, 202, 204, 400, 405, 422, 429, 502, 503]) expect(statuses.has(s)).toBe(true);
    for (const r of seen) {
      expect(r.headers.get("access-control-allow-origin")).toBe("*");
      expect(r.headers.get("cache-control")).toBe("no-store");
      expect(r.headers.get("content-type")).toBe("application/json");
      expect(r.headers.get("set-cookie")).toBeNull();
      expect(r.body).not.toMatch(/analysis|retrofit_visitor/i);
      expect(r.body).not.toContain(`${PUBLIC_ORIGIN}/r/`);
      expect(r.body).not.toContain(`${PUBLIC_ORIGIN}/p/`);
    }
  });

  // Fails if a slot is left held after the route's own dispatch.
  it("leaves no slot held after a completed score", async () => {
    const server = await serveSites(() => ({ "bakery.fixture.test": bakery }));
    close = () => server.close();
    const d = testDeps({ env: { SCORE_WAIT_MS: "5000", CRAWL_MAX_CONCURRENT: "1" } });
    expect((await call(d, q(server.origin("bakery.fixture.test")))).status).toBe(200);
    await d.settle();
    expect(await d.store.acquireLease(slotKey(0), 1)).not.toBeNull();
  });
});
