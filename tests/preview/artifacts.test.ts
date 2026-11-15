import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { getAnalysis, readAnalysisView } from "@/lib/analysis/record";
import { visitorTexts } from "@/lib/analysis/texts";
import { handleAnalyze } from "@/lib/api/analyze";
import { generateNetwork } from "@/lib/generate/network";
import { handlePreviewFile } from "@/lib/preview/artifacts";
import { toSiteContent } from "@/lib/snapshot/types";
import { bakery } from "../fixtures/sites";
import { previewRequest, readyBakeryPreview, type ReadyPreview } from "../generate/preview-setup";
import { analyzeRequest, cookieFrom, holdAllSlots, testDeps } from "../helpers/server-deps";
import { serveSites } from "../helpers/sites";

const ASSETS = path.resolve(__dirname, "../../public/preview-assets");
const OTHER_COOKIE = `retrofit_visitor=${"b".repeat(32)}`;

let preview: ReadyPreview | undefined;
afterEach(async () => {
  await preview?.close();
  preview = undefined;
});

async function ready() {
  preview = await readyBakeryPreview();
  // The analysis copies the snapshot from the ready job on its first view read.
  const { analysis } = await readAnalysisView(preview.d, (await getAnalysis(preview.d.store, preview.id))!);
  const g = generateNetwork({ snapshot: analysis.snapshot!, publicOrigin: preview.d.config.publicOrigin });
  // `null` sends no Cookie header; leaving the argument out sends the owner's cookie.
  const get = (segments: string[], cookie: string | null = preview!.cookie) =>
    handlePreviewFile(previewRequest(preview!.id, segments, cookie ?? undefined), preview!.d, preview!.id, segments);
  return { ...preview, analysis, g, get };
}

// Fails if any preview response becomes cacheable, indexable, sniffable or readable cross-origin.
function expectPreviewHeaders(res: Response) {
  expect(res.headers.get("cache-control")).toBe("private, no-store");
  expect(res.headers.get("x-robots-tag")).toBe("noindex");
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect(res.headers.get("access-control-allow-origin")).toBeNull();
  expect(res.headers.get("set-cookie")).toBeNull();
}

describe("preview owner check", () => {
  // Fails if a preview is readable without the owner's cookie, or if the 404 differs between "other owner" and "no such id".
  it("missing cookie, another visitor and an unknown id all get the same 404 text", async () => {
    const { get, id, d } = await ready();
    const expected = { error: "not_found", message: visitorTexts.otherBrowser };
    const cases: Response[] = [
      await get(["agent-manifest.json"], null),
      await get(["agent-manifest.json"], OTHER_COOKIE),
      await get(["site-content.json"], "retrofit_visitor=not-a-token"),
      await handlePreviewFile(previewRequest("0".repeat(32), ["agent-manifest.json"], preview!.cookie), d, "0".repeat(32), ["agent-manifest.json"]),
      await handlePreviewFile(previewRequest("nope", ["agent-manifest.json"], preview!.cookie), d, "nope", ["agent-manifest.json"]),
      // The unknown file of another visitor's preview gets the owner 404 too, so nothing about the preview leaks.
      await get(["unknown.json"], OTHER_COOKIE),
    ];
    for (const res of cases) {
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual(expected);
      expectPreviewHeaders(res);
    }
    expect(id).toMatch(/^[0-9a-f]{32}$/);
  }, 30_000);

  // Fails if an expired preview is still served, or answers 404 instead of 410 with the expiry text.
  it("an expired analysis returns 410 with the expiry text", async () => {
    const { get, fc, analysis } = await ready();
    fc.set(analysis.expiresAt + 1000);
    const res = await get(["agent-manifest.json"]);
    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({ error: "expired", message: "This preview expired on 22 November 2026. Analyze the site again." });
    expectPreviewHeaders(res);
  }, 30_000);

  // Fails if a preview is served before its analysis is ready.
  it("an analysis that is not ready returns 404 with the generation text", async () => {
    const server = await serveSites(() => ({ "bakery.fixture.test": bakery }));
    try {
      const d = testDeps();
      await holdAllSlots(d);
      const res0 = await handleAnalyze(analyzeRequest({ url: server.origin("bakery.fixture.test") }), d);
      const cookie = cookieFrom(res0);
      const { id } = (await res0.json()) as { id: string };
      const res = await handlePreviewFile(previewRequest(id, ["agent-manifest.json"], cookie), d, id, ["agent-manifest.json"]);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not_ready", message: visitorTexts.generationFailed });
      expectPreviewHeaders(res);
    } finally {
      await server.close();
    }
  }, 30_000);
});

describe("preview files", () => {
  // Fails if a served file's body or content type differs from what the runtime fetches.
  it("serves the manifest, network, site content, links, content actions and bridge with their content types", async () => {
    const { get, g, analysis } = await ready();
    const cases: [string[], string, (body: string) => void][] = [
      [["agent-manifest.json"], "application/json", (b) => expect(JSON.parse(b)).toEqual(g.manifest)],
      [[`${g.networkName}.network.json`], "application/json", (b) => expect(JSON.parse(b)).toEqual(g.network)],
      [["site-content.json"], "application/json", (b) => expect(JSON.parse(b)).toEqual(toSiteContent(analysis.snapshot!))],
      [["links.json"], "application/json", (b) => expect(JSON.parse(b)).toEqual({ version: 1, networks: {} })],
    ];
    for (const [segments, type, check] of cases) {
      const res = await get(segments);
      expect(res.status, segments.join("/")).toBe(200);
      expect(res.headers.get("content-type")).toBe(type);
      expectPreviewHeaders(res);
      check(await res.text());
    }
    const js = await get(["content-actions.js"]);
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(await js.text()).toBe(await readFile(path.join(ASSETS, "content-actions.js"), "utf8"));
    expectPreviewHeaders(js);
    const bridge = await get(["bridge", "action-bridge.html"]);
    expect(bridge.status).toBe(200);
    expect(bridge.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await bridge.text()).toBe(await readFile(path.join(ASSETS, "bridge", "action-bridge.html"), "utf8"));
    expectPreviewHeaders(bridge);
  }, 30_000);

  // Fails if the manifest's hocon and the served network file name disagree (the runtime would 404 the network).
  it("the manifest's hocon path names the served network file", async () => {
    const { get, g } = await ready();
    const manifest = (await (await get(["agent-manifest.json"])).json()) as { networks: { hocon: string }[] };
    const file = manifest.networks[0]!.hocon.replace(/^\.\//, "");
    expect((await get([file])).status).toBe(200);
    expect(file).toBe(`${g.networkName}.network.json`);
  }, 30_000);

});

describe("preview file allowlist", () => {
  let shared: ReadyPreview | undefined;
  beforeAll(async () => {
    shared = await readyBakeryPreview();
  }, 30_000);
  afterAll(async () => {
    await shared?.close();
  });

  // Fails if any path outside the allowlist, or any traversal, reaches the disk or returns 200.
  it.each([
    [["unknown.json"]],
    [["site_other.network.json"]],
    [["package.json"]],
    [[".."]],
    [["..", "package.json"]],
    [["bridge", "..", "content-actions.js"]],
    [["bridge", "..", "..", "..", "package.json"]],
    [["bridge", "../../../package.json"]],
    [["bridge", "..%2F..%2Fpackage.json"]],
    [["bridge", "action-bridge.html\u0000"]],
    [["bridge", "missing.html"]],
    [["bridge", ".hidden.html"]],
    [["bridge"]],
    [["bridge", "a", "action-bridge.html"]],
    [["content-actions.js", "x"]],
    [["CONTENT-ACTIONS.JS"]],
    [["agent-manifest.json", ""]],
    [[]],
  ])("refuses %j with 404", async (segments) => {
    const res = await handlePreviewFile(previewRequest(shared!.id, segments, shared!.cookie), shared!.d, shared!.id, segments);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
    expectPreviewHeaders(res);
  }, 30_000);
});
