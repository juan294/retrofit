import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "@/lib/config";
import { getJob, resolveJob, startOrJoinCrawl, type JobDeps } from "@/lib/crawl/jobs";
import { runCrawl, type WorkerDeps } from "@/lib/crawl/worker";
import { createFetchContext } from "@/lib/fetch/context";
import type { FetchContext } from "@/lib/fetch/http";
import { createMemoryBacking, createMemoryStore } from "@/lib/store/memory";
import type { Snapshot } from "@/lib/snapshot/types";
import { bakery, blocked, convergeTo, redirectWww } from "../fixtures/sites";
import { FAST_TOLERANCE_MS } from "../helpers/server-deps";
import { serveSites } from "../helpers/sites";

const config = loadConfig({ SESSION_SECRET: "x".repeat(32), RETROFIT_TEST_FIXTURES: "1" });
let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

function instance(backing: ReturnType<typeof createMemoryBacking>, clock: () => number): WorkerDeps {
  const store = createMemoryStore({ backing, clock });
  return { store, config, clock, fetch: createFetchContext({ config, store, clock, minIntervalMs: 1, lateStartToleranceMs: FAST_TOLERANCE_MS }) };
}

describe("runCrawl", () => {
  // Fails if the worker does not write the snapshot to the job.
  it("crawls a queued job to ready", async () => {
    const server = await serveSites(() => ({ "bakery.fixture.test": bakery }));
    close = () => server.close();
    const w = instance(createMemoryBacking(), Date.now);
    const { jobId } = await startOrJoinCrawl(w, server.origin("bakery.fixture.test"));
    expect(await runCrawl(jobId, w)).toBe("ready");
    const job = await getJob<Snapshot, unknown>(w.store, jobId);
    expect(job?.status).toBe("ready");
    expect(job?.snapshot?.pages.length).toBe(4);
    expect(job?.leaseExpiresAt).toBeUndefined();
  });

  // Fails if two input hosts that redirect to one destination each crawl it.
  it("makes converge-a and converge-b share one crawl of the destination", async () => {
    const server = await serveSites((o) => ({
      "dest.fixture.test": bakery,
      "converge-a.fixture.test": convergeTo(o("dest.fixture.test")),
      "converge-b.fixture.test": convergeTo(o("dest.fixture.test")),
    }));
    close = () => server.close();
    const backing = createMemoryBacking();
    const a = instance(backing, Date.now);
    const b = instance(backing, Date.now);
    const ja = await startOrJoinCrawl(a, server.origin("converge-a.fixture.test"));
    const jb = await startOrJoinCrawl(b, server.origin("converge-b.fixture.test"));
    const outcomes = (await Promise.all([runCrawl(ja.jobId, a), runCrawl(jb.jobId, b)])).sort();
    expect(outcomes).toEqual(["joined", "ready"]);
    const ra = await resolveJob<Snapshot, unknown>(a.store, ja.jobId);
    const rb = await resolveJob<Snapshot, unknown>(b.store, jb.jobId);
    expect(ra?.id).toBe(rb?.id);
    expect(ra?.status).toBe("ready");
    const menuFetches = server.requests.filter((r) => r.host === "dest.fixture.test" && r.path === "/menu");
    expect(menuFetches).toHaveLength(1);
  });

  // Fails if a home page that redirects to a sign-in path is requested, or the job does not fail with the
  // contract's crawl_error (the tool contract has no dedicated code for it).
  it("fails with crawl_error, without contacting it, when the home page redirects to a private path", async () => {
    const server = await serveSites(() => ({ "gated.fixture.test": { ...bakery, "/": { status: 302, headers: { location: "/login" } } } }));
    close = () => server.close();
    const w = instance(createMemoryBacking(), Date.now);
    const { jobId } = await startOrJoinCrawl(w, server.origin("gated.fixture.test"));
    expect(await runCrawl(jobId, w)).toBe("failed");
    expect((await getJob(w.store, jobId))?.failure?.code).toBe("crawl_error");
    expect(server.requests.map((r) => r.path)).toEqual(["/robots.txt", "/"]);
  });

  // Fails if a robots refusal on the redirect target is not recorded as robots_blocked.
  it("fails with robots_blocked when the redirect target disallows RetrofitBot", async () => {
    const server = await serveSites((o) => ({ "www.fixture.test": redirectWww(o("apex.fixture.test")), "apex.fixture.test": blocked }));
    close = () => server.close();
    const w = instance(createMemoryBacking(), Date.now);
    const { jobId } = await startOrJoinCrawl(w, server.origin("www.fixture.test"));
    expect(await runCrawl(jobId, w)).toBe("failed");
    expect((await getJob(w.store, jobId))?.failure?.code).toBe("robots_blocked");
    expect(server.requests.filter((r) => r.host === "apex.fixture.test").map((r) => r.path)).toEqual(["/robots.txt"]);
  });

  // Fails if a worker whose lease expired can still write (the fence).
  it("writes nothing after its lease expires and another worker takes over", async () => {
    const server = await serveSites(() => ({ "bakery.fixture.test": bakery }));
    close = () => server.close();
    // Real time plus a jump, so pacing sleeps still end.
    let offset = 0;
    const clock = () => Date.now() + offset;
    const backing = createMemoryBacking();
    const a = instance(backing, clock);
    const b = instance(backing, clock);
    const { jobId } = await startOrJoinCrawl(a, server.origin("bakery.fixture.test"));
    let takenOver = false;
    const slowFetch: FetchContext = {
      ...a.fetch,
      pace: async (host, delay) => {
        await a.fetch.pace(host, delay);
        if (!takenOver && host.startsWith("bakery.fixture.test") && (await getJob(a.store, jobId))?.step?.startsWith("probe ")) {
          takenOver = true;
          offset += (config.crawlLeaseTtlS + 1) * 1000;
          // Another instance acquires the expired lease, as a retry would.
          expect(await b.store.acquireLease(`crawl-lease:${jobId}`, config.crawlLeaseTtlS)).not.toBeNull();
        }
      },
    };
    const outcome = await runCrawl(jobId, { ...a, fetch: slowFetch } satisfies WorkerDeps);
    expect(takenOver).toBe(true);
    expect(outcome).toBe("lease-lost");
    expect((await getJob(a.store, jobId))?.status).toBe("crawling");
  });

  // Fails if a second worker can run the same job while the first holds its lease,
  // or if a busy worker skips onFinish (Phase 3 frees its capacity slot there).
  it("returns busy when the lease is held and still runs onFinish", async () => {
    const w = instance(createMemoryBacking(), Date.now);
    const { jobId } = await startOrJoinCrawl(w as JobDeps & WorkerDeps, "https://bakery.example");
    await w.store.acquireLease(`crawl-lease:${jobId}`, 60);
    let finished = 0;
    expect(await runCrawl(jobId, { ...w, onFinish: async () => void finished++ })).toBe("busy");
    expect(finished).toBe(1);
  });
});
