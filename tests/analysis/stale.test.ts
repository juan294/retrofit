import { describe, expect, it } from "vitest";
import { getAnalysis } from "@/lib/analysis/record";
import { handleAnalysisStatus } from "@/lib/api/status";
import { handleAnalyze } from "@/lib/api/analyze";
import { getJob, leaseKey, updateJob, type CrawlJob } from "@/lib/crawl/jobs";
import { analyzeRequest, cookieFrom, fakeClock, holdAllSlots, statusRequest, testDeps } from "../helpers/server-deps";

describe("stale crawl jobs", () => {
  // Fails if the status read does not apply the stale rule (lease ended and updatedAt older than
  // STALE_AFTER_S), applies it too early, if Retry reuses the dead job, or if the old worker's
  // late write is accepted.
  it("marks a job failed at 91 s but not at 89 s; Retry starts a new job; the old worker's write is discarded", async () => {
    const fc = fakeClock();
    const d = testDeps({ clock: fc.clock });
    await holdAllSlots(d);
    const res = await handleAnalyze(analyzeRequest({ url: "https://slow.example.com" }), d);
    const cookie = cookieFrom(res);
    const { id } = (await res.json()) as { id: string };
    const jobId = (await getAnalysis(d.store, id))!.jobId;

    // A worker takes the job and then stops (its function was killed).
    const workerToken = await d.store.acquireLease(leaseKey(jobId), d.config.crawlLeaseTtlS);
    expect(workerToken).not.toBeNull();
    const queued = (await getJob(d.store, jobId)) as CrawlJob;
    const crawling = await updateJob(d, queued, { status: "crawling", step: "home", leaseExpiresAt: fc.now() + d.config.crawlLeaseTtlS * 1000 });
    expect(crawling).not.toBeNull();

    const read = async () => (await handleAnalysisStatus(statusRequest(id, { cookie }), d, id)).json();
    fc.advance(89_000);
    expect(await read()).toEqual({ status: "crawling", step: "home", scoreReady: false });
    expect((await getJob(d.store, jobId))?.status).toBe("crawling");

    fc.advance(2_000);
    expect(await read()).toEqual({
      status: "failed",
      step: "failed",
      failure: { code: "stale", message: "This analysis took too long. Try again." },
      scoreReady: false,
    });
    expect((await getJob(d.store, jobId))?.failure?.code).toBe("stale");

    // Retry: a new analysis of the same URL starts a new job.
    const retry = await handleAnalyze(analyzeRequest({ url: "https://slow.example.com" }, { cookie }), d);
    const { id: retryId } = (await retry.json()) as { id: string };
    const retryJob = (await getAnalysis(d.store, retryId))!.jobId;
    expect(retryJob).not.toBe(jobId);
    expect((await getJob(d.store, retryJob))?.status).toBe("queued");

    // The old worker wakes up: its lease is gone and its job version is out of date.
    expect(await d.store.renewLease(leaseKey(jobId), workerToken!, d.config.crawlLeaseTtlS)).toBe(false);
    expect(await updateJob(d, crawling!, { status: "ready", step: "ready" })).toBeNull();
    expect((await getJob(d.store, jobId))?.status).toBe("failed");
  });
});
