import { afterEach, describe, expect, it } from "vitest";
import { CRAWL_QUEUE, dispatchQueued, MAX_DURATION_S, slotKey, startCrawlJob } from "@/lib/analysis/capacity";
import { getAnalysis } from "@/lib/analysis/record";
import { startAnalysis } from "@/lib/analysis/run";
import { handleAnalysisStatus } from "@/lib/api/status";
import { handleAnalyze } from "@/lib/api/analyze";
import { handleScore } from "@/lib/api/score";
import { getJob, leaseKey, originAliasKey, resolveJob, startOrJoinCrawl, type CrawlJob } from "@/lib/crawl/jobs";
import { loadConfig } from "@/lib/config";
import { createMemoryStore } from "@/lib/store/memory";
import type { Store } from "@/lib/store/types";
import { shortHash } from "@/lib/fetch/limits";
import { bakery } from "../fixtures/sites";
import {
  analyzeRequest,
  cookieFrom,
  fakeClock,
  holdAllSlots,
  scoreRequest,
  serveGatedSites,
  statusRequest,
  testDeps,
  waitFor,
  type TestDeps,
} from "../helpers/server-deps";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function jobFor(d: TestDeps, origin: string): Promise<CrawlJob | null> {
  const alias = await d.store.get<{ jobId: string }>(originAliasKey(origin));
  return alias ? resolveJob(d.store, alias.jobId) : null;
}

async function statuses(d: TestDeps, origins: string[]): Promise<string[]> {
  return Promise.all(origins.map(async (o) => (await jobFor(d, o))?.status ?? "missing"));
}

const count = (xs: string[], s: string) => xs.filter((x) => x === s).length;

function hosts(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `site${i + 1}.fixture.test`);
}

describe("capacity", () => {
  // Fails if more than CRAWL_MAX_CONCURRENT crawls run at once, or a queued job is not
  // started when a running worker finishes (worker-completion dispatch).
  it("keeps the ninth concurrent job queued until a slot frees, then starts it", async () => {
    const names = hosts(9);
    const server = await serveGatedSites(Object.fromEntries(names.map((h) => [h, bakery])), names);
    close = () => server.close();
    const d = testDeps();
    const origins = names.map((h) => server.origin(h));
    for (const [i, o] of origins.entries()) {
      const r = await startAnalysis(d, { rawUrl: o, ownerHash: "a".repeat(64), clientId: `client-${i}` });
      expect(r.ok).toBe(true);
    }
    await waitFor(async () => count(await statuses(d, origins), "crawling") === 8, "8 crawling");
    await waitFor(() => server.maxWaiting === 8, "8 home pages held");
    const ninth = origins[8] as string;
    expect((await jobFor(d, ninth))?.status).toBe("queued");
    expect(server.requests.some((r) => r.host === "site9.fixture.test")).toBe(false);

    server.gate("site1.fixture.test").open();
    await waitFor(async () => (await jobFor(d, ninth))?.status === "crawling", "ninth job crawling");
    expect((await jobFor(d, origins[0] as string))?.status).toBe("ready");
    expect(server.maxWaiting).toBe(8);

    for (const h of names) server.gate(h).open();
    await d.settle();
    expect(await statuses(d, origins)).toEqual(Array(9).fill("ready"));
    expect(d.errors).toEqual([]);
  });

  // Fails if queued API-only jobs depend on status polling: with no request after the
  // first 12, every job must still complete through worker-completion dispatch.
  it("completes 12 API-only score requests for distinct hosts with 8 slots and no polling", async () => {
    const names = hosts(12);
    const server = await serveGatedSites(Object.fromEntries(names.map((h) => [h, bakery])), names);
    close = () => server.close();
    const d = testDeps({ env: { SCORE_WAIT_MS: "1" } });
    const origins = names.map((h) => server.origin(h));
    const responses = await Promise.all(origins.map((o) => handleScore(scoreRequest(`?url=${encodeURIComponent(o)}`), d)));
    expect(responses.map((r) => r.status)).toEqual(Array(12).fill(202));
    await waitFor(async () => count(await statuses(d, origins), "crawling") === 8, "8 crawling");
    await waitFor(() => server.maxWaiting === 8, "8 home pages held");
    expect(count(await statuses(d, origins), "queued")).toBe(4);
    expect(server.requests.filter((r) => r.path === "/").length).toBe(8);

    for (const h of names) server.gate(h).open();
    await d.settle();
    expect(await statuses(d, origins)).toEqual(Array(12).fill("ready"));
    expect(server.maxWaiting).toBe(8);
    // Every slot is free again.
    for (let n = 0; n < 8; n++) expect(await d.store.acquireLease(slotKey(n), 1)).not.toBeNull();
    expect(d.errors).toEqual([]);
  });

  // Fails if a crashed worker's slot is never reused: its lease expires and the next score retry must dispatch.
  it("dispatches the queued job on the next score retry after a crashed worker's slot lease expires", async () => {
    const server = await serveGatedSites({ "bakery.fixture.test": bakery }, []);
    close = () => server.close();
    let offset = 0;
    const clock = () => Date.now() + offset;
    const advance = async (ms: number) => {
      offset += ms;
      await new Promise((r) => setTimeout(r, 1));
    };
    const d = testDeps({ clock, env: { CRAWL_MAX_CONCURRENT: "1", SCORE_WAIT_MS: "3000" } });
    // A worker took slot 0 and crashed: nothing will release it.
    expect(await d.store.acquireLease(slotKey(0), d.config.crawlLeaseTtlS)).not.toBeNull();
    const url = `?url=${encodeURIComponent(server.origin("bakery.fixture.test"))}`;

    const first = await handleScore(scoreRequest(url), { ...d, sleep: advance });
    expect(first.status).toBe(202);
    expect((await jobFor(d, server.origin("bakery.fixture.test")))?.status).toBe("queued");

    offset += (d.config.crawlLeaseTtlS + 1) * 1000;
    const retry = await handleScore(scoreRequest(url), d);
    expect(retry.status).toBe(200);
    expect(((await retry.json()) as { status: string }).status).toBe("ready");
    await d.settle();
    expect(await d.store.acquireLease(slotKey(0), 1)).not.toBeNull();
    expect(d.errors).toEqual([]);
  });

  // Fails if a job that waited past QUEUE_MAX_WAIT_S is still reported as queued, or if a new request does not queue it again.
  it("reads a job queued for 121 s as expired with the too-busy text, and a new request queues it again", async () => {
    const fc = fakeClock();
    const d = testDeps({ clock: fc.clock });
    await holdAllSlots(d);
    const res = await handleAnalyze(analyzeRequest({ url: "https://busy.example.com" }), d);
    const { id } = (await res.json()) as { id: string };
    const cookie = cookieFrom(res);
    const read = async () => (await handleAnalysisStatus(statusRequest(id, { cookie }), d, id)).json();

    fc.advance(119_000);
    expect(await read()).toEqual({ status: "queued", step: "queued", scoreReady: false });
    fc.advance(2_000);
    expect(await read()).toEqual({
      status: "failed",
      step: "failed",
      failure: { code: "queue_expired", message: "Retrofit is too busy right now. Try again in a few minutes." },
      scoreReady: false,
    });

    const oldJob = (await getAnalysis(d.store, id))!.jobId;
    const again = await handleAnalyze(analyzeRequest({ url: "https://busy.example.com" }, { cookie }), d);
    const { id: id2 } = (await again.json()) as { id: string };
    const newJob = (await getAnalysis(d.store, id2))!.jobId;
    expect(newJob).not.toBe(oldJob);
    expect((await getJob(d.store, newJob))?.status).toBe("queued");
    expect(await d.store.claimNext(CRAWL_QUEUE)).toBe(newJob);
  });

  // Fails if the score API reports a queue-expired job as running instead of 503 queue_expired.
  it("answers 503 queue_expired with retryAfterSeconds 120 when the job's queue time passes 120 s", async () => {
    const fc = fakeClock();
    const sleep = async (ms: number) => fc.advance(ms);
    const d = testDeps({ clock: fc.clock, sleep });
    await holdAllSlots(d);
    const url = "?url=https%3A%2F%2Fbusy.example.com";
    expect((await handleScore(scoreRequest(url), d)).status).toBe(202);
    fc.set(fc.now() - d.config.scoreWaitMs + 100_000); // 100 s after the job was queued
    const res = await handleScore(scoreRequest(url), d);
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("120");
    expect(await res.json()).toEqual({
      status: "error",
      error: "queue_expired",
      message: "Retrofit is too busy right now. Try again in a few minutes.",
      retryAfterSeconds: 120,
    });
  });

  // Fails if the daily destination cap is not enforced, counts a repeat origin twice, or does not reset at 00:00 UTC.
  it("returns the daily cap text when CRAWL_MAX_HOSTS_PER_DAY is reached", async () => {
    const fc = fakeClock(Date.parse("2026-11-15T22:00:00.000Z"));
    const d = testDeps({ clock: fc.clock, env: { CRAWL_MAX_HOSTS_PER_DAY: "2" } });
    await holdAllSlots(d);
    const analyze = async (host: string, ip = "203.0.113.7") => handleAnalyze(analyzeRequest({ url: `https://${host}` }, { ip }), d);
    expect((await analyze("one.example.com")).status).toBe(200);
    expect((await analyze("two.example.com")).status).toBe(200);
    expect((await analyze("one.example.com")).status).toBe(200);
    const third = await analyze("three.example.com");
    expect(third.status).toBe(429);
    expect(await third.json()).toEqual({
      error: "daily_limit",
      message: "Retrofit reached today's analysis limit. Try again tomorrow.",
      retryAt: "2026-11-16T00:00:00.000Z",
    });

    const api = await handleScore(scoreRequest("?url=https%3A%2F%2Ffour.example.com"), d);
    expect(api.status).toBe(429);
    expect(api.headers.get("retry-after")).toBe("7200");
    expect(await api.json()).toEqual({
      status: "error",
      error: "daily_limit",
      message: "Retrofit reached today's analysis limit. Try again tomorrow.",
      retryAfterSeconds: 7200,
      retryAt: "2026-11-16T00:00:00.000Z",
    });

    fc.set(Date.parse("2026-11-16T00:00:01.000Z"));
    expect((await analyze("three.example.com", "203.0.113.99")).status).toBe(200);
  });

  // F1, validation V04. Fails if an undecided daily count (another job of the same origin still being
  // counted) queues or counts the job, which would let it pass a full daily cap, or answers daily_limit,
  // which would tell the visitor the limit was reached when it may not have been. The next request must
  // decide again with a new job.
  it("leaves the job undispatched with a counting retry when the origin's daily count is still undecided", async () => {
    const fc = fakeClock(Date.parse("2026-11-15T10:20:00.000Z"));
    const d = testDeps({ clock: fc.clock });
    await holdAllSlots(d);
    const origin = "https://pending.example.com";
    const marker = `crawl-origin-day:2026-11-15:${shortHash(origin)}`;
    await d.store.putIfAbsent(marker, { version: 1, state: "pending" }, 10);
    const r = await startCrawlJob(d, origin);
    expect(r).toEqual({ ok: false, code: "counting" });
    expect(await d.store.claimNext(CRAWL_QUEUE)).toBeNull();
    expect(await d.store.incrementWindow("crawl-origins:2026-11-15", 3600, 0)).toBe(0);
    const held = await jobFor(d, origin);
    expect(held?.status).toBe("failed");
    expect(held?.failure?.code).toBe("counting");

    // Once the other decision is gone, the next request creates a new job, counts it and queues it.
    await d.store.delete(marker);
    const next = await startCrawlJob(d, origin);
    expect(next.ok && next.created).toBe(true);
    if (next.ok) expect(next.jobId).not.toBe(held?.id);
    expect(await d.store.incrementWindow("crawl-origins:2026-11-15", 3600, 0)).toBe(1);
    expect(await d.store.claimNext(CRAWL_QUEUE)).toBe(next.ok ? next.jobId : "none");
  });

  // Adopted from the validator's reproduction (.local/validation-2141fc4/regressions.test.ts:19), validation
  // V04. Fails if a replacement job queues while the first request's daily decision is pending at an
  // exhausted cap (supported QUEUE_MAX_WAIT_S=1 lets the replacement start), or if it reports daily_limit.
  it("does not queue a replacement while the daily cap decision remains pending at an exhausted cap", async () => {
    let t = Date.parse("2026-11-15T10:20:00Z");
    const clock = () => t;
    const config = loadConfig({ SESSION_SECRET: "s".repeat(32), CRAWL_MAX_HOSTS_PER_DAY: "1", QUEUE_MAX_WAIT_S: "1" });
    const store = createMemoryStore({ clock });
    await store.incrementWindow("crawl-origins:2026-11-15", 3600);
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const pause = new Promise<void>((resolve) => {
      release = resolve;
    });
    let firstCount = true;
    const delayed: Store = {
      ...store,
      async incrementWindow(key: string, ttl: number, by?: number) {
        if (key.startsWith("crawl-origins:") && firstCount) {
          firstCount = false;
          entered();
          await pause;
        }
        return store.incrementWindow(key, ttl, by);
      },
    };
    const deps = { store: delayed, config, clock };
    const first = startCrawlJob(deps, "https://pending.example.com");
    await waiting;
    t += 1001;
    let second;
    try {
      second = await startCrawlJob(deps, "https://pending.example.com");
    } finally {
      release();
    }
    expect(second).toEqual({ ok: false, code: "counting" });
    expect(await first).toEqual({ ok: false, code: "daily_limit", retryAt: Date.parse("2026-11-16T00:00:00Z") });
    expect(await store.claimNext(CRAWL_QUEUE)).toBeNull();
  });

  // Fails if a worker that finds its job lease held ("busy") keeps the capacity slot.
  it("releases the slot when the worker returns busy", async () => {
    const d = testDeps({ env: { CRAWL_MAX_CONCURRENT: "1" } });
    const { jobId } = await startOrJoinCrawl(d, "https://held.example.com");
    await d.store.acquireLease(leaseKey(jobId), 60);
    await d.store.enqueue(CRAWL_QUEUE, jobId, 120);
    expect(await dispatchQueued(d, { startedAt: d.clock() })).toBe(1);
    await d.settle();
    expect(await d.store.acquireLease(slotKey(0), 1)).not.toBeNull();
    expect(d.errors).toEqual([]);
  });

  // Fails if dispatch takes a slot when the queue is empty, or does nothing when all slots are taken.
  it("returns 0 and keeps every slot free when the queue is empty", async () => {
    const d = testDeps({ env: { CRAWL_MAX_CONCURRENT: "2" } });
    expect(await dispatchQueued(d, { startedAt: d.clock() })).toBe(0);
    expect(await d.store.acquireLease(slotKey(0), 1)).not.toBeNull();
    expect(await d.store.acquireLease(slotKey(1), 1)).not.toBeNull();
    await d.store.enqueue(CRAWL_QUEUE, "some-job", 120);
    expect(await dispatchQueued(d, { startedAt: d.clock() })).toBe(0);
    expect(await d.store.claimNext(CRAWL_QUEUE)).toBe("some-job");
  });
});

describe("dispatch store work (validation V16)", () => {
  // Fails if dispatch tries one lease per slot (eight sequential RPCs on Supabase at full capacity)
  // instead of one atomic claim.
  it("makes one store call when every slot is held and a job is queued", async () => {
    const ops: string[] = [];
    const d = testDeps({ instrument: (op) => void ops.push(op) });
    await holdAllSlots(d);
    await d.store.enqueue(CRAWL_QUEUE, "waiting-job", 120);
    ops.length = 0;
    expect(await dispatchQueued(d, { startedAt: d.clock() })).toBe(0);
    expect(ops).toEqual(["claimWithLease"]);
    expect(await d.store.claimNext(CRAWL_QUEUE)).toBe("waiting-job");
  });

  // Fails if dispatch acquires, claims and releases a slot when nothing is queued.
  it("makes one store call and takes no slot when the queue is empty", async () => {
    const ops: string[] = [];
    const d = testDeps({ instrument: (op) => void ops.push(op), env: { CRAWL_MAX_CONCURRENT: "2" } });
    expect(await dispatchQueued(d, { startedAt: d.clock() })).toBe(0);
    expect(ops).toEqual(["claimWithLease"]);
  });

  // Fails if a status request without the owner's cookie or with an invalid id starts dispatch work.
  it("does no dispatch work for status requests that are not the owner's", async () => {
    const ops: string[] = [];
    const d = testDeps({ instrument: (op) => void ops.push(op) });
    const slots = await holdAllSlots(d);
    const owner = await handleAnalyze(analyzeRequest({ url: "https://owned.example.com" }), d);
    const stranger = await handleAnalyze(analyzeRequest({ url: "https://other.example.com" }), d);
    const { id } = (await owner.json()) as { id: string };
    for (const [n, t] of slots.entries()) await d.store.releaseLease(slotKey(n), t);
    await d.settle();
    ops.length = 0;
    await handleAnalysisStatus(statusRequest(id), d, id);
    await handleAnalysisStatus(statusRequest("not-an-id", { cookie: cookieFrom(owner) }), d, "not-an-id");
    await handleAnalysisStatus(statusRequest(id, { cookie: cookieFrom(stranger) }), d, id);
    await d.settle();
    expect(ops).toEqual(["get"]);
    // The owner's request dispatches the queued jobs.
    await handleAnalysisStatus(statusRequest(id, { cookie: cookieFrom(owner) }), d, id);
    await d.settle();
    expect(ops).toContain("claimWithLease");
  });
});

describe("capacity review fixes", () => {
  // P3-R1. Fails if a finishing worker starts the next queued job when its own invocation has too
  // little of MAX_DURATION_S left for a full crawl (the job would be killed mid-crawl), or if the
  // next request does not start the job left queued.
  it("leaves the next job queued when the finishing worker's invocation is short of time, and the next request starts it", async () => {
    expect(MAX_DURATION_S).toBe(60);
    const server = await serveGatedSites({ "first.fixture.test": bakery, "second.fixture.test": bakery }, ["first.fixture.test"]);
    close = () => server.close();
    let offset = 0;
    const d = testDeps({ clock: () => Date.now() + offset, env: { CRAWL_MAX_CONCURRENT: "1" } });
    const first = server.origin("first.fixture.test");
    const second = server.origin("second.fixture.test");
    expect((await handleAnalyze(analyzeRequest({ url: first }), d)).status).toBe(200);
    await waitFor(() => server.gate("first.fixture.test").waiting === 1, "first home page held");
    const res = await handleAnalyze(analyzeRequest({ url: second }), d);
    const { id } = (await res.json()) as { id: string };
    expect((await jobFor(d, second))?.status).toBe("queued");

    // The first crawl ends 46 s into its invocation: 46 + 45 (crawl budget) + 10 > 60.
    offset += 46_000;
    server.gate("first.fixture.test").open();
    await d.settle();
    expect((await jobFor(d, first))?.status).toBe("ready");
    expect((await jobFor(d, second))?.status).toBe("queued");
    expect(server.requests.some((r) => r.host === "second.fixture.test")).toBe(false);

    // A new request is a new invocation with its full time, so it dispatches.
    await handleAnalysisStatus(statusRequest(id, { cookie: cookieFrom(res) }), d, id);
    await d.settle();
    expect((await jobFor(d, second))?.status).toBe("ready");
    expect(d.errors).toEqual([]);
  });

  // P3-N1. Fails if a worker that is short of time neither dispatches nor kicks a fresh invocation:
  // a visitor with a hidden tab would wait for the 120 s queue expiry.
  it("kicks a fresh invocation when the finishing worker is short of time", async () => {
    const server = await serveGatedSites({ "first.fixture.test": bakery, "second.fixture.test": bakery }, ["first.fixture.test"]);
    close = () => server.close();
    let offset = 0;
    let kicks = 0;
    const base = testDeps({ clock: () => Date.now() + offset, env: { CRAWL_MAX_CONCURRENT: "1" } });
    const d = { ...base, kick: async () => void kicks++ };
    expect((await handleAnalyze(analyzeRequest({ url: server.origin("first.fixture.test") }), d)).status).toBe(200);
    await waitFor(() => server.gate("first.fixture.test").waiting === 1, "first home page held");
    await handleAnalyze(analyzeRequest({ url: server.origin("second.fixture.test") }), d);
    offset += 46_000;
    server.gate("first.fixture.test").open();
    await base.settle();
    expect(kicks).toBe(1);
    // The kicked invocation is a new invocation with its full time.
    const { handleDispatch } = await import("@/lib/api/dispatch");
    const { dispatchToken } = await import("@/lib/server/runtime");
    const bad = await handleDispatch(new Request("https://retrofit.test/api/internal/dispatch", { method: "POST", headers: { authorization: "Bearer nope" } }), d);
    expect(bad.status).toBe(401);
    const ok = await handleDispatch(new Request("https://retrofit.test/api/internal/dispatch", { method: "POST", headers: { authorization: `Bearer ${dispatchToken(d.config)}` } }), d);
    expect(ok.status).toBe(202);
    expect(await ok.json()).toEqual({ started: 1 });
    await base.settle();
    expect((await jobFor(d, server.origin("second.fixture.test")))?.status).toBe("ready");
  });

  // P3-R5. Fails if the slot lease is not renewed while the worker runs: with a 1 s lease, a worker held
  // for 1.6 s would lose its slot and a second crawl could start beyond CRAWL_MAX_CONCURRENT.
  // loadConfig keeps every request inside the lease (budget + FETCH_TIMEOUT_MS <= lease), so the worker is
  // held in a store call instead: its first job-lease renewal waits until the test opens it.
  it("renews the slot lease while the worker runs and frees it in the end", async () => {
    const server = await serveGatedSites({ "slow.fixture.test": bakery }, []);
    close = () => server.close();
    const base = createMemoryStore();
    let held = false;
    let open: () => void = () => {};
    const gate = new Promise<void>((r) => (open = r));
    const store = {
      ...base,
      renewLease: async (key: string, token: string, ttl: number) => {
        if (key.startsWith("crawl-lease:") && !held) {
          held = true;
          await gate;
        }
        return base.renewLease(key, token, ttl);
      },
    };
    const d = testDeps({ store, env: { CRAWL_MAX_CONCURRENT: "1", CRAWL_LEASE_TTL_S: "1", CRAWL_BUDGET_MS: "600", FETCH_TIMEOUT_MS: "400" } });
    expect((await handleAnalyze(analyzeRequest({ url: server.origin("slow.fixture.test") }), d)).status).toBe(200);
    await waitFor(() => held, "worker held in its first lease renewal");
    await new Promise((r) => setTimeout(r, 1600));
    expect(await d.store.acquireLease(slotKey(0), 1)).toBeNull();
    open();
    await d.settle();
    expect(await d.store.acquireLease(slotKey(0), 1)).not.toBeNull();
    expect(d.errors).toEqual([]);
  });

  // P3-R8. Fails if an analyze or score request that returns early (403, 400, 429) does not dispatch queued work.
  it.each([
    ["analyze 403", 403, (d: TestDeps) => handleAnalyze(analyzeRequest({ url: "https://x.example.com" }, { fetchSite: null, origin: "https://evil.example" }), d)],
    ["analyze 400", 400, (d: TestDeps) => handleAnalyze(analyzeRequest({ url: "ftp://x.example.com" }), d)],
    ["analyze 429", 429, (d: TestDeps) => handleAnalyze(analyzeRequest({ url: "https://x.example.com" }, { ip: "203.0.113.200" }), d)],
    ["score 400", 400, (d: TestDeps) => handleScore(scoreRequest("?url="), d)],
    ["score 429", 429, (d: TestDeps) => handleScore(scoreRequest("?url=https%3A%2F%2Fx.example.com", { ip: "203.0.113.200" }), d)],
  ] as const)("dispatches a queued job on an early return (%s)", async (_name, status, send) => {
    const d = testDeps({ env: { ANALYSES_PER_CLIENT_HOUR: "1" } });
    const slots = await holdAllSlots(d);
    const queued = await startCrawlJob(d, "https://queued.example.com");
    if (!queued.ok) throw new Error("expected a queued job");
    // Use up this client's window, so the 429 cases return early.
    expect((await handleAnalyze(analyzeRequest({ url: "https://y.example.com" }, { ip: "203.0.113.200" }), d)).status).toBe(200);
    for (const [n, t] of slots.entries()) await d.store.releaseLease(slotKey(n), t);
    await d.settle();
    // Releasing slots dispatches nothing by itself.
    expect((await getJob(d.store, queued.jobId))?.status).toBe("queued");

    const res = await send(d);
    // The documented status of each early return: 403 cross-origin, 400 bad address, 429 client limit.
    expect(res.status).toBe(status);
    await d.settle();
    // The crawl ran (it fails at the guard: every test name resolves to a private address).
    expect((await getJob(d.store, queued.jobId))?.status).toBe("failed");
  });
});
