import { afterEach, describe, expect, it } from "vitest";
import { CRAWL_QUEUE, dispatchQueued, slotKey } from "@/lib/analysis/capacity";
import { getAnalysis } from "@/lib/analysis/record";
import { startAnalysis } from "@/lib/analysis/run";
import { handleAnalysisStatus } from "@/lib/api/status";
import { handleAnalyze } from "@/lib/api/analyze";
import { handleScore } from "@/lib/api/score";
import { getJob, leaseKey, originAliasKey, resolveJob, startOrJoinCrawl, type CrawlJob } from "@/lib/crawl/jobs";
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

  // Fails if a worker that finds its job lease held ("busy") keeps the capacity slot.
  it("releases the slot when the worker returns busy", async () => {
    const d = testDeps({ env: { CRAWL_MAX_CONCURRENT: "1" } });
    const { jobId } = await startOrJoinCrawl(d, "https://held.example.com");
    await d.store.acquireLease(leaseKey(jobId), 60);
    await d.store.enqueue(CRAWL_QUEUE, jobId, 120);
    expect(await dispatchQueued(d)).toBe(1);
    await d.settle();
    expect(await d.store.acquireLease(slotKey(0), 1)).not.toBeNull();
    expect(d.errors).toEqual([]);
  });

  // Fails if dispatch takes a slot when the queue is empty, or does nothing when all slots are taken.
  it("returns 0 and keeps every slot free when the queue is empty", async () => {
    const d = testDeps({ env: { CRAWL_MAX_CONCURRENT: "2" } });
    expect(await dispatchQueued(d)).toBe(0);
    expect(await d.store.acquireLease(slotKey(0), 1)).not.toBeNull();
    expect(await d.store.acquireLease(slotKey(1), 1)).not.toBeNull();
    await d.store.enqueue(CRAWL_QUEUE, "some-job", 120);
    expect(await dispatchQueued(d)).toBe(0);
    expect(await d.store.claimNext(CRAWL_QUEUE)).toBe("some-job");
  });
});

