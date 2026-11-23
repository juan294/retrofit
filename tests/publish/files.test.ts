/**
 * The public agent files of a published site (src/lib/publish/files.ts): the exact file set and
 * headers, bytes equal to the install bundle, no Retrofit inference URL, and 404 for a host that is
 * not public or not in its exact normalized form.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { AccountData } from "@/lib/accounts/data";
import { AccountDataUnavailable } from "@/lib/accounts/data";
import { bundleFiles } from "@/lib/bundle/files";
import { networkNameFor } from "@/lib/generate/network";
import { BRIDGE_RUNTIME_FILES, handlePublishedFile } from "@/lib/publish/files";
import { exactHost } from "@/lib/publish/host";
import type { Snapshot } from "@/lib/snapshot/types";
import { PUBLISHED_PAGE_TEXT } from "@/lib/site/publish-texts";
import { crawlFixtureSnapshots, SITES, type SiteName } from "../helpers/fixture-snapshots";
import { testDeps, type TestDeps } from "../helpers/server-deps";
import { HOST, publishDirect, snapshotOf, verifiedClaim } from "./setup";

const JSON_TYPE = "application/json";
const JS_TYPE = "text/javascript; charset=utf-8";
const HTML_TYPE = "text/html; charset=utf-8";

let snapshots: Map<SiteName, Snapshot>;
beforeAll(async () => {
  snapshots = await crawlFixtureSnapshots();
}, 60_000);

async function published(snapshot: Snapshot): Promise<TestDeps> {
  const d = testDeps();
  await verifiedClaim(d, undefined, snapshot.host);
  await publishDirect(d, snapshot);
  return d;
}
const paths = (host: string): [string, string][] => [
  ["agent-manifest.json", JSON_TYPE],
  [`${networkNameFor(host)}.network.json`, JSON_TYPE],
  ["site-content.json", JSON_TYPE],
  ["links.json", JSON_TYPE],
  ["bridge/agent-manifest.json", JSON_TYPE],
  ["content-actions.js", JS_TYPE],
  ["bridge/action-bridge.html", HTML_TYPE],
  ...BRIDGE_RUNTIME_FILES.map((f): [string, string] => [`runtime/${f}`, JS_TYPE]),
];
const get = (d: TestDeps, host: string, file: string) => handlePublishedFile(d, host, file.split("/"));

describe("published agent files", () => {
  // Fails if a file is missing, has another type, is cacheable (an unpublish must end it at once), sniffable, sets a cookie, or CORS is
  // on anything but the agent JSON files.
  it("serves the whole set with its types; only the agent JSON files allow every origin", async () => {
    const snapshot = snapshots.get("bakery")!;
    const d = await published(snapshot);
    for (const [file, type] of paths(snapshot.host)) {
      const res = await get(d, snapshot.host, file);
      expect(res.status, file).toBe(200);
      expect(res.headers.get("content-type"), file).toBe(type);
      expect(res.headers.get("cache-control"), file).toBe("private, no-store");
      expect(res.headers.get("x-content-type-options"), file).toBe("nosniff");
      expect(res.headers.get("x-robots-tag"), file).toBe("noindex");
      expect(res.headers.get("set-cookie"), file).toBeNull();
      expect(res.headers.get("access-control-allow-origin"), file).toBe(type === JSON_TYPE ? "*" : null);
    }
  });

  // Fails if a published file differs from the install bundle's, names Retrofit's inference routes, or calls the agent a preview.
  it.each(Object.keys(SITES) as SiteName[])("%s: the files are the install bundle's bytes, with the BYOK router and no /api/inference", async (name) => {
    const snapshot = snapshots.get(name)!;
    const d = await published(snapshot);
    const { entries, topFolder } = await bundleFiles(snapshot);
    const bundle = new Map(entries.map((e) => [e.path.slice(`${topFolder}/site/`.length), e.bytes]));
    for (const [file] of paths(snapshot.host)) {
      const bytes = Buffer.from(await (await get(d, snapshot.host, file)).arrayBuffer());
      expect(bytes.equals(bundle.get(file)!), file).toBe(true);
      expect(bytes.includes("/api/inference"), file).toBe(false);
    }
    const manifest = (await (await get(d, snapshot.host, "agent-manifest.json")).json()) as { llm_router: Record<string, unknown>; brand: string; networks: { description: string }[]; allowed_peers: unknown[] };
    expect(manifest.llm_router).toMatchObject({ base_url: "https://api.otari.ai/api/v1", byok_router: "https://api.otari.ai/api/v1", mock: false });
    expect(manifest.brand).toBe(`${snapshot.host} assistant`);
    expect(JSON.stringify(manifest)).not.toMatch(/preview|unofficial/i);
    expect(manifest.allowed_peers).toEqual([]);
  });

  // Fails if the bridge page cannot start (a runtime module it imports is missing), or more of the runtime is served than it needs.
  it("the bridge's runtime files are exactly its module's imports", async () => {
    const seen = new Set<string>();
    const queue = ["action-bridge.js"];
    for (let f = queue.shift(); f; f = queue.shift()) {
      if (seen.has(f)) continue;
      seen.add(f);
      const source = await readFile(path.resolve("public/runtime", f), "utf8");
      for (const m of source.matchAll(/from "\.\/([a-z-]+\.js)"/g)) queue.push(m[1]!);
    }
    expect([...BRIDGE_RUNTIME_FILES].sort()).toEqual([...seen].sort());
    const page = await readFile(path.resolve("public/preview-assets/bridge/action-bridge.html"), "utf8");
    expect(page).toContain('src="../runtime/action-bridge.js"');
  });

  // Fails if the bridge shares any action or loads any module of the site: it must stay data-only on Retrofit's origin.
  it("the bridge manifest shares no action, module, page or catalog", async () => {
    const d = await published(snapshotOf(HOST, "2026-11-20T08:00:00.000Z"));
    expect(await (await get(d, HOST, "bridge/agent-manifest.json")).json()).toEqual({ networks: [{ name: networkNameFor(HOST) }], actions: { version: 1 } });
  });

  // Fails if any other path answers: the bundle, templates with placeholder actions, other runtime files, traversal or another network.
  it("answers 404 for every other path", async () => {
    const d = await published(snapshotOf(HOST, "2026-11-20T08:00:00.000Z"));
    for (const segments of [
      ["bundle.zip"],
      ["bridge", "bridge-actions.js"],
      ["bridge", "write-window.js"],
      ["bridge", ".."],
      ["bridge", "..", "content-actions.js"],
      ["bridge", "../content-actions.js"],
      ["bridge/action-bridge.html"],
      ["runtime/action-bridge.js"],
      ["bridge", "%2e%2e%2fcontent-actions.js"],
      ["runtime", "index.js"],
      ["runtime", "sandbox-worker.js"],
      ["runtime", "generated", "agent-runner.bundle.js"],
      ["runtime", "../preview-assets/content-actions.js"],
      ["site_other.network.json"],
      ["agent-manifest.json", ""],
      ["", "agent-manifest.json"],
      ["Agent-Manifest.json"],
      ["__proto__"],
      [],
    ]) {
      const res = await handlePublishedFile(d, HOST, segments);
      expect(res.status, JSON.stringify(segments)).toBe(404);
      expect(await res.json()).toEqual({ error: "not_found", message: PUBLISHED_PAGE_TEXT.filesNotFound });
      expect(res.headers.get("cache-control")).toBe("private, no-store");
    }
  });

  // Fails if a host that is not public answers differently from an unknown one, or a host in another form answers.
  it("answers the same 404 for an unknown, claimed-but-unpublished and differently written host", async () => {
    const d = await published(snapshotOf(HOST, "2026-11-20T08:00:00.000Z"));
    await verifiedClaim(d, undefined, "claimed.example.com");
    for (const host of ["unknown.example.com", "claimed.example.com", "SHOP.example.com", "shop.example.com.", "shop.example.com:443", "shop%2eexample.com", " shop.example.com", "shop.example.com/", "..", "127.1", ""]) {
      const res = await get(d, host, "agent-manifest.json");
      expect(res.status, host).toBe(404);
      expect(await res.json()).toEqual({ error: "not_found", message: PUBLISHED_PAGE_TEXT.filesNotFound });
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    }
  });

  // Fails if the scripts' request loads the snapshot, or an outage looks like an unknown host.
  it("scripts use the light read; an outage answers 503", async () => {
    const d = await published(snapshotOf(HOST, "2026-11-20T08:00:00.000Z"));
    const down = (o: Partial<AccountData>): TestDeps => ({ ...d, accounts: { ...d.accounts, ...o } });
    const fail = async () => { throw new AccountDataUnavailable("x", "request_failed"); };
    const noSnapshot = down({ getPublicSnapshot: fail });
    for (const file of ["content-actions.js", "bridge/action-bridge.html", "bridge/agent-manifest.json", "links.json", "runtime/action-bridge.js"]) expect((await get(noSnapshot, HOST, file)).status, file).toBe(200);
    const res = await get(noSnapshot, HOST, "agent-manifest.json");
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "unavailable", message: PUBLISHED_PAGE_TEXT.unavailable });
    expect((await get(down({ getPublicSite: fail }), HOST, "content-actions.js")).status).toBe(503);
  });

  // Fails if a stored snapshot the validator refuses is served.
  it("a stored snapshot the validator refuses answers 404, never a broken network", async () => {
    const d = await published(snapshotOf(HOST, "2026-11-20T08:00:00.000Z"));
    const res = await handlePublishedFile({ ...d, validate: () => ["bad"] }, HOST, ["agent-manifest.json"]);
    expect(res.status).toBe(404);
  });
});

describe("exactHost", () => {
  // Fails if a host in any form but the normalized one is accepted (the framework may pass a colon encoded, which is the same host).
  it("accepts only the normalized form", () => {
    expect(exactHost("shop.example.com")).toBe("shop.example.com");
    expect(exactHost("xn--bcher-kva.example")).toBe("xn--bcher-kva.example");
    expect(exactHost("bakery.fixture.test:3011")).toBe("bakery.fixture.test:3011");
    expect(exactHost("bakery.fixture.test%3A3011")).toBe("bakery.fixture.test:3011");
    for (const bad of ["Shop.example.com", "bücher.example", "shop.example.com:443", "shop.example.com.", "shop%2Eexample.com", "a/b", "a b", "a%20b", "..", ".", "", "user@shop.example.com", "a:b:c", "x".repeat(300)]) expect(exactHost(bad), bad).toBeNull();
  });
});
