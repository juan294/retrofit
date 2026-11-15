import { afterEach, describe, expect, it } from "vitest";
import { getAnalysis } from "@/lib/analysis/record";
import { handleAnalysisStatus } from "@/lib/api/status";
import { handleAnalyze } from "@/lib/api/analyze";
import { jobKey } from "@/lib/crawl/jobs";
import { bakery } from "../fixtures/sites";
import { serveSites } from "../helpers/sites";
import { analyzeRequest, cookieFrom, fakeClock, statusRequest, testDeps } from "../helpers/server-deps";

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

describe("analysis expiry", () => {
  // Fails if the analysis does not copy the snapshot and score from the ready job (so the preview
  // would vanish with the 24 h crawl cache), or if it does not read as expired after expiresAt.
  it("keeps the preview readable after the crawl cache expires, then reads as expired at expiresAt + 1 s", async () => {
    const server = await serveSites(() => ({ "bakery.fixture.test": bakery }));
    close = () => server.close();
    const fc = fakeClock(Date.parse("2026-11-15T10:20:00.000Z"));
    const d = testDeps({ clock: fc.clock });
    const res = await handleAnalyze(analyzeRequest({ url: server.origin("bakery.fixture.test") }), d);
    const cookie = cookieFrom(res);
    const { id } = (await res.json()) as { id: string };
    await d.settle();
    const read = async (include?: string) => (await handleAnalysisStatus(statusRequest(id, { cookie, include }), d, id)).json();

    expect(await read()).toEqual({ status: "ready", step: "ready", scoreReady: true });
    const analysis = (await getAnalysis(d.store, id))!;
    expect(analysis.expiresAt).toBe(Date.parse("2026-11-15T10:20:00.000Z") + d.config.analysisTtlS * 1000);
    expect(analysis.snapshot).toBeDefined();

    // 25 hours later the shared crawl job is gone from the store.
    fc.advance(25 * 3600_000);
    expect(await d.store.get(jobKey(analysis.jobId))).toBeNull();
    const result = (await read("result")) as { status: string; report: { status: string; host: string } | null };
    expect(result.status).toBe("ready");
    expect(result.report?.status).toBe("ready");
    expect(result.report?.host).toBe(new URL(server.origin("bakery.fixture.test")).host);
    expect((await getAnalysis(d.store, id))?.snapshot?.pages.length).toBe(4);

    fc.set(analysis.expiresAt - 1000);
    expect(await read()).toEqual({ status: "ready", step: "ready", scoreReady: true });

    fc.set(analysis.expiresAt + 1000);
    expect(await read()).toEqual({
      status: "expired",
      step: "expired",
      failure: { code: "expired", message: "This preview expired on 22 November 2026. Analyze the site again." },
      scoreReady: false,
    });
    expect(await read("result")).toMatchObject({ status: "expired", report: null });
    expect(d.errors).toEqual([]);
  });
});
