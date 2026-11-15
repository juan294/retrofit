import { describe, expect, it } from "vitest";
import { loadConfig } from "@/lib/config";
import { analysisKey, createAnalysis, readAnalysisView, type Analysis } from "@/lib/analysis/record";
import { jobKey } from "@/lib/crawl/jobs";
import { createMemoryStore } from "@/lib/store/memory";

const now = Date.parse("2026-11-15T12:00:00Z");
const clock = () => now;
const config = loadConfig({ SESSION_SECRET: "s".repeat(32) });

describe("readAnalysisView", () => {
  // V01 (validator regression). Fails if a reader that loses the compare-and-set returns ready with
  // its old copy of the analysis, which has no score.
  it("both concurrent readers of a ready job get its copied score", async () => {
    const store = createMemoryStore({ clock });
    const deps = { store, config, clock };
    const analysis = await createAnalysis(deps, { ownerHash: "owner", jobId: "ready-job", inputOrigin: "https://example.test" });
    await store.set(
      jobKey("ready-job"),
      { version: 1, id: "ready-job", inputOrigin: analysis.inputOrigin, status: "ready", step: "ready", snapshot: { fixture: true }, score: { total: 42 }, createdAt: now, updatedAt: now },
      600,
    );
    const views = await Promise.all([readAnalysisView(deps, analysis), readAnalysisView(deps, analysis)]);
    for (const view of views) {
      expect(view.status).toBe("ready");
      expect(view.analysis.score).toEqual({ total: 42 });
      expect(view.analysis.readyAt).toBe(now);
    }
    // One copy was committed; the loser used it instead of writing again.
    expect((await store.get<Analysis>(analysisKey(analysis.id)))?.version).toBe(2);
  });
});
