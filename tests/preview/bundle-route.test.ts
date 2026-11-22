import { execFileSync } from "node:child_process";
import { afterEach, expect, it } from "vitest";
import { analysisKey, getAnalysis } from "@/lib/analysis/record";
import { visitorTexts } from "@/lib/analysis/texts";
import { handleAnalyze } from "@/lib/api/analyze";
import { handleAnalysisStatus } from "@/lib/api/status";
import { handlePreviewFile, type PreviewDeps } from "@/lib/preview/artifacts";
import { previewRequest, readyBakeryPreview, type ReadyPreview } from "../generate/preview-setup";
import { analyzeRequest, cookieFrom, holdAllSlots, testDeps } from "../helpers/server-deps";

let owner: ReadyPreview | undefined;
afterEach(async () => { await owner?.close(); owner = undefined; });

function download(id: string, cookie: string | undefined, deps: PreviewDeps) {
  return handlePreviewFile(previewRequest(id, ["bundle.zip"], cookie), deps, id, ["bundle.zip"]);
}

it("downloads a valid private ZIP attachment for the analysis owner", async () => {
  owner = await readyBakeryPreview();
  const res = await download(owner.id, owner.cookie, owner.d);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("application/zip");
  expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="retrofit-bakery\.fixture\.test-\d+-2026-11-15\.zip"$/);
  expect(res.headers.get("cache-control")).toBe("private, no-store");
  expect(res.headers.get("x-robots-tag")).toBe("noindex");
  expect(res.headers.has("access-control-allow-origin")).toBe(false);
  execFileSync("python3", ["-I", "-c", "import io,sys,zipfile; z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())); assert z.testzip() is None; assert any(p.endswith('/site/agent-manifest.json') for p in z.namelist())"], { input: Buffer.from(await res.arrayBuffer()) });
});

it("uses the preview recovery messages for a missing owner, expiry, validation failure and store outage", async () => {
  owner = await readyBakeryPreview();
  const { id, cookie, d, fc } = owner;
  for (const other of [undefined, "retrofit_visitor=" + "b".repeat(32)]) {
    const res = await download(id, other, d);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found", message: visitorTexts.otherBrowser });
  }
  const invalid = await download(id, cookie, { ...d, validate: () => ["invalid network"] });
  expect(invalid.status).toBe(404);
  expect(await invalid.json()).toEqual({ error: "generation_failed", message: visitorTexts.generationFailed });
  const offline = testDeps({ instrument: () => { throw new Error("store offline"); } });
  const outage = await download(id, cookie, offline);
  expect(outage.status).toBe(503);
  expect(await outage.json()).toEqual({ error: "unavailable", message: visitorTexts.unavailable });
  const { expiresAt } = (await getAnalysis(d.store, id))!;
  fc.set(expiresAt + 1);
  const expired = await download(id, cookie, d);
  expect(expired.status).toBe(410);
  expect(await expired.json()).toEqual({ error: "expired", message: visitorTexts.expired(new Date(expiresAt)) });
});

it("refuses a queued analysis with the generation recovery text", async () => {
  const deps = testDeps();
  await holdAllSlots(deps);
  const start = await handleAnalyze(analyzeRequest({ url: "http://queued.fixture.test:3011/" }), deps);
  const { id } = await start.json();
  const res = await download(id, cookieFrom(start), deps);
  expect(res.status).toBe(404);
  expect(await res.json()).toEqual({ error: "not_ready", message: visitorTexts.generationFailed });
  await deps.settle();
});

it("the result offers installation only when the saved snapshot can generate an agent", async () => {
  owner = await readyBakeryPreview();
  const { d, cookie, id } = owner;
  const report = () => handleAnalysisStatus(new Request(`http://retrofit.test/api/analyze/${id}?include=result`, { headers: { cookie } }), d, id);
  expect((await (await report()).json()).bundleReady).toBe(true);
  const analysis = (await getAnalysis(d.store, id))!;
  await d.store.set(analysisKey(id), { ...analysis, snapshot: { ...analysis.snapshot, host: "" } }, 3600);
  const failed = await (await report()).json();
  expect(failed.report).toBeTruthy();
  expect(failed.bundleReady).toBe(false);
  await d.settle();
});
