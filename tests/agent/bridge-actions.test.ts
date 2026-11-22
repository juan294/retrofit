// Retrofit's shared score_site action (public/bridge/bridge-actions.js). Partner sites that
// call retrofit_guide load Retrofit's action bridge in a hidden frame; the bridge registers
// this module's actions and shares the ones whose callerOrigins match the caller
// (runtime/action-transport.js serveActionBridge). The registry is the vendored runtime's
// own; fetch is stubbed at the network boundary.

import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { ActionRegistry } from "../../tools/agentic-web/runtime/actions.js";
import { websiteToolRefusal } from "../../tools/agentic-web/runtime/runner.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const bridgeModuleUrl = pathToFileURL(`${root}public/bridge/bridge-actions.js`).href;
const siteModuleUrl = pathToFileURL(`${root}public/site-actions.js`).href;

interface Entry {
  name: string;
  description: string;
  effect: string;
  availability: string;
  callerOrigins: string[];
  inputSchema: Record<string, unknown>;
  execute: (args: unknown, context: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

type Module = { registerActions: (a: { register(d: unknown): void }) => void };

async function entriesOf(moduleUrl: string): Promise<Entry[]> {
  const mod = (await import(/* @vite-ignore */ moduleUrl)) as Module;
  const registry = new ActionRegistry();
  const scope = { base: "https://retrofit.example/", network: "retrofit_guide" };
  mod.registerActions({ register: (d) => registry.register(scope, d) });
  return [...registry.entries.values()] as Entry[];
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Retrofit's action bridge shares score_site", () => {
  it("registers exactly score_site as a read shared with every caller origin", async () => {
    // Fails if the module is missing, registers the local-only action, or limits the callers.
    const entries = await entriesOf(bridgeModuleUrl);
    expect(entries.map((e) => [e.name, e.effect, e.availability, e.callerOrigins])).toEqual([["score_site", "read", "bridge", ["*"]]]);
  });

  it("keeps the local action's description and input schema, so peers see the same contract", async () => {
    const [shared] = await entriesOf(bridgeModuleUrl);
    const [local] = await entriesOf(siteModuleUrl);
    expect(local!.availability).toBe("local-only");
    expect(shared!.description).toBe(local!.description);
    expect(shared!.inputSchema).toEqual(local!.inputSchema);
  });

  it("asks Retrofit's own score API from the bridge frame and maps a ready answer", async () => {
    const body = {
      status: "ready",
      scoreVersion: "score/v1",
      host: "bakery.example",
      score: 62,
      checks: Array.from({ length: 16 }, (_, i) => ({ id: `c${i}`, group: "g", weight: 1, result: "pass", rule: "r", evidence: "e" })),
    };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const [shared] = await entriesOf(bridgeModuleUrl);
    const result = await shared!.execute({ url: "bakery.example" }, { requestId: "r1", callerOrigin: "https://partner.example" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe("/api/score?url=bakery.example");
    expect(result).toMatchObject({ ok: true, status: "ready", report: { host: "bakery.example", score: 62 } });
  });

  it("points a peer's visitor at Retrofit's home page, not at the calling page's form, when the answer is unreadable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not json", { status: 200 })));
    const [shared] = await entriesOf(bridgeModuleUrl);
    const result = await shared!.execute({ url: "bakery.example" }, { requestId: "r2", callerOrigin: "https://partner.example" });
    expect(result.ok).toBe(false);
    const reason = String(result.reason);
    expect(reason).not.toContain("this page");
    expect(reason).toContain(new URL("../", bridgeModuleUrl).href);
  });
});

describe("a partner network that runs retrofit_guide gets website_score_site", () => {
  // The vendored runtime's own rule (runtime/runner.js websiteToolRefusal) with Retrofit's published manifest.
  const manifest = JSON.parse(readFileSync(`${root}public/agent-manifest.json`, "utf8"));
  const partner = { manifest, isTop: false };

  it("accepts the shared bridge action in a partner context", async () => {
    const [shared] = await entriesOf(bridgeModuleUrl);
    expect(websiteToolRefusal(partner, shared)).toBe("");
  });

  it("refuses the local-only page action in a partner context, so only the bridge copy reaches partners", async () => {
    const [local] = await entriesOf(siteModuleUrl);
    expect(websiteToolRefusal(partner, local)).toBe("a partner network gets only actions its bridge shares");
  });

  it("names the bridge module in the published bridge manifest", () => {
    const bridgeManifest = JSON.parse(readFileSync(`${root}public/bridge/agent-manifest.json`, "utf8"));
    expect(bridgeManifest.actions).toEqual({ version: 1, module: "./bridge-actions.js" });
    expect(bridgeManifest.networks).toEqual([{ name: "retrofit_guide" }]);
  });
});

describe("score_site polls inside one bridge call", () => {
  // The runtime opens a new bridge frame for every partner call (runtime/action-transport.js), so state kept
  // between calls is lost. The shared action waits and asks again within one call instead, below the caller's
  // 180 s execute timeout.
  const running = () => new Response(JSON.stringify({ status: "running" }), { status: 202, headers: { "content-type": "application/json" } });
  const ready = () =>
    new Response(
      JSON.stringify({ status: "ready", scoreVersion: "score/v1", host: "bakery.example", score: 62, checks: Array.from({ length: 16 }, (_, i) => ({ id: `c${i}` })) }),
      { status: 200, headers: { "content-type": "application/json" } },
    );

  afterEach(() => {
    vi.useRealTimers();
  });

  async function runWith(answers: (() => Response)[]) {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const start = Date.now();
    const calls: number[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls.push(Date.now() - start);
        return (answers[calls.length - 1] ?? answers[answers.length - 1]!)();
      }),
    );
    const [shared] = await entriesOf(bridgeModuleUrl);
    const pending = shared!.execute({ url: "bakery.example" }, { requestId: "p1", callerOrigin: "https://partner.example" });
    await vi.runAllTimersAsync();
    return { result: await pending, calls, elapsed: Date.now() - start };
  }

  it("returns the ready answer after running answers, 20 s apart, in one call", async () => {
    const { result, calls } = await runWith([running, running, ready]);
    expect(result).toMatchObject({ ok: true, status: "ready", report: { score: 62 } });
    expect(calls).toHaveLength(3);
    expect(calls[1]! - calls[0]!).toBeGreaterThanOrEqual(20_000);
    expect(calls[2]! - calls[1]!).toBeGreaterThanOrEqual(20_000);
  });

  it("stops within the caller's execute timeout and tells the model not to call again", async () => {
    const { result, calls, elapsed } = await runWith([running]);
    expect(result).toMatchObject({ ok: false, status: "running", reason: "The score is still running after several checks. Tell the user to try again in a few minutes." });
    expect(result.retryAfterSeconds).toBeUndefined();
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(elapsed).toBeLessThan(180_000);
  });
});

describe("the page's own score_site keeps one request per call", () => {
  it("returns running after one request, for the model to call again", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ status: "running" }), { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    const [local] = await entriesOf(siteModuleUrl);
    const result = await local!.execute({ url: "bakery.example" }, { requestId: "l1" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: false, status: "running", retryAfterSeconds: 20 });
  });
});
