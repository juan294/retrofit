import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { visitorTexts } from "@/lib/analysis/texts";
import { GenerationFailed, generateNetwork, validateGenerated } from "@/lib/generate/network";
import { handlePreviewFile } from "@/lib/preview/artifacts";
import type { Snapshot } from "@/lib/snapshot/types";
import { crawlFixtureSnapshots, PUBLIC_ORIGIN } from "../helpers/fixture-snapshots";
import { previewRequest, readyBakeryPreview, type ReadyPreview } from "./preview-setup";

let bakery: Snapshot;
let preview: ReadyPreview | undefined;
beforeAll(async () => {
  bakery = (await crawlFixtureSnapshots()).get("bakery")!;
}, 60_000);
afterEach(async () => {
  await preview?.close();
  preview = undefined;
});

const forced = () => ["Forced validator failure for the test."];

describe("generation failure", () => {
  // Fails if validateGenerated stops calling the vendored validator (a front man naming a missing tool passes).
  it("the vendored validator turns a network naming a missing tool into GenerationFailed with its message", () => {
    const g = generateNetwork({ snapshot: bakery, publicOrigin: PUBLIC_ORIGIN });
    const broken = structuredClone(g.network) as unknown as { tools: { tools: string[] }[] };
    broken.tools[0]!.tools = ["missing_agent"];
    expect(() => validateGenerated(broken, g.networkName)).toThrow(GenerationFailed);
    expect(() => validateGenerated(broken, g.networkName)).toThrow("Agent 'site_guide' references missing tool 'missing_agent'.");
  });

  // Fails if a validator error is swallowed (fail open) or its message is replaced.
  it("a forced validator failure gives GenerationFailed with the validator message", () => {
    let caught: unknown;
    try {
      generateNetwork({ snapshot: bakery, publicOrigin: PUBLIC_ORIGIN }, { validate: forced });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(GenerationFailed);
    expect((caught as GenerationFailed).message).toBe("Forced validator failure for the test.");
    expect((caught as GenerationFailed).name).toBe("GenerationFailed");
  });

  // Fails if the visitor text drifts from the parent plan's stuck-state row.
  it("has the plan's visitor text", () => {
    expect(visitorTexts.generationFailed).toBe("Retrofit could not build a working agent for this site.");
  });

  // Fails if the preview route serves a network that failed validation, or answers with another status or text.
  it("the preview handler returns 404 with the visitor text when generation fails", async () => {
    preview = await readyBakeryPreview();
    const { d, id, cookie } = preview;
    for (const file of [["agent-manifest.json"], ["site-content.json"], ["content-actions.js"]]) {
      const res = await handlePreviewFile(previewRequest(id, file, cookie), { ...d, validate: forced }, id, file);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "generation_failed", message: visitorTexts.generationFailed });
    }
    // The same analysis serves normally with the real validator, so the 404 above came from the forced failure.
    const ok = await handlePreviewFile(previewRequest(id, ["agent-manifest.json"], cookie), d, id, ["agent-manifest.json"]);
    expect(ok.status).toBe(200);
  }, 30_000);
});
