import { describe, expect, it } from "vitest";
import { loadConfig } from "@/lib/config";
import {
  claimDestination,
  getJob,
  readJobMarkingStale,
  resolveJob,
  startOrJoinCrawl,
  updateJob,
  type JobDeps,
} from "@/lib/crawl/jobs";
import { createMemoryBacking, createMemoryStore } from "@/lib/store/memory";
import { jitter } from "../helpers/jitter-store";

function setup() {
  let now = Date.UTC(2026, 10, 15, 12);
  const clock = () => now;
  const backing = createMemoryBacking();
  const config = loadConfig({ SESSION_SECRET: "x".repeat(32), RETROFIT_TEST_FIXTURES: "1" });
  const a: JobDeps = { store: createMemoryStore({ clock, backing }), config, clock };
  const b: JobDeps = { store: createMemoryStore({ clock, backing }), config, clock };
  return { a, b, config, advance: (ms: number) => (now += ms), now: () => now };
}

describe("startOrJoinCrawl", () => {
  // Fails if the origin alias is not written with putIfAbsent (two jobs would be created).
  it("creates one job for ten concurrent calls on two instances", async () => {
    const { a, b } = setup();
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => startOrJoinCrawl(i % 2 ? a : b, "https://bakery.example")));
    const ids = new Set(results.map((r) => r.jobId));
    expect(ids.size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
  });

  // Fails if the alias can point at a job that is not written yet (a second caller would replace it).
  it("creates one job when store operations interleave at random", async () => {
    for (let trial = 0; trial < 20; trial++) {
      const { a, b } = setup();
      const ja = { ...a, store: jitter(a.store) };
      const jb = { ...b, store: jitter(b.store) };
      const results = await Promise.all(Array.from({ length: 10 }, (_, i) => startOrJoinCrawl(i % 2 ? ja : jb, "https://bakery.example")));
      expect(new Set(results.map((r) => r.jobId)).size).toBe(1);
    }
  });

  // Fails if a failed job is reused instead of replaced.
  it("replaces a failed job and reuses a fresh ready one", async () => {
    const { a, advance, config } = setup();
    const first = await startOrJoinCrawl(a, "https://bakery.example");
    const job = (await getJob(a.store, first.jobId))!;
    await updateJob(a, job, { status: "failed", failure: { code: "x", message: "x" } });
    const second = await startOrJoinCrawl(a, "https://bakery.example");
    expect(second.created).toBe(true);
    expect(second.jobId).not.toBe(first.jobId);

    const j2 = (await getJob(a.store, second.jobId))!;
    await updateJob(a, j2, { status: "ready" });
    expect(await startOrJoinCrawl(a, "https://bakery.example")).toEqual({ jobId: second.jobId, created: false });
    advance(config.crawlCacheTtlS * 1000 + 1000);
    expect((await startOrJoinCrawl(a, "https://bakery.example")).created).toBe(true);
  });
});

describe("claimDestination and joins", () => {
  // Fails if two input hosts that converge on one destination both crawl it.
  it("joins the second job to the first owner of the destination", async () => {
    const { a, b } = setup();
    const ja = await startOrJoinCrawl(a, "http://converge-a.fixture.test:1");
    const jb = await startOrJoinCrawl(b, "http://converge-b.fixture.test:1");
    const [ca, cb] = await Promise.all([claimDestination(a, ja.jobId, "dest.fixture.test"), claimDestination(b, jb.jobId, "dest.fixture.test")]);
    const owners = [ca, cb].filter((x) => x === null);
    expect(owners).toHaveLength(1);
    const joinerId = ca === null ? jb.jobId : ja.jobId;
    const ownerId = ca === null ? ja.jobId : jb.jobId;
    expect(ca ?? cb).toBe(ownerId);
    const joiner = (await getJob(a.store, joinerId))!;
    await updateJob(a, joiner, { status: "joined", joinedTo: ownerId });
    expect((await resolveJob(a.store, joinerId))!.id).toBe(ownerId);
  });
});

describe("stale jobs and fencing", () => {
  // Fails if the stale rule ignores updatedAt (89 s) or the lease (91 s).
  it("marks a crawling job failed only after the lease ended and 90 s passed", async () => {
    const { a, advance } = setup();
    const { jobId } = await startOrJoinCrawl(a, "https://bakery.example");
    const job = (await getJob(a.store, jobId))!;
    await updateJob(a, job, { status: "crawling", leaseExpiresAt: a.clock() + 60_000 });
    advance(89_000);
    expect((await readJobMarkingStale(a, jobId))!.status).toBe("crawling");
    advance(2_000);
    const read = (await readJobMarkingStale(a, jobId))!;
    expect(read.status).toBe("failed");
    expect(read.failure?.code).toBe("stale");
  });

  // Fails if a worker could overwrite a newer job state (no compare-and-set on version).
  it("discards a late completion after a stale failure", async () => {
    const { a, b, advance } = setup();
    const { jobId } = await startOrJoinCrawl(a, "https://bakery.example");
    const workerView = (await updateJob(a, (await getJob(a.store, jobId))!, { status: "crawling", leaseExpiresAt: a.clock() + 60_000 }))!;
    advance(91_000);
    expect((await readJobMarkingStale(b, jobId))!.status).toBe("failed");
    expect(await updateJob(a, workerView, { status: "ready" })).toBeNull();
    expect((await getJob(a.store, jobId))!.status).toBe("failed");
  });
});
