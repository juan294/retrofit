/**
 * What a publication stores (agentSnapshot, src/lib/snapshot/types.ts): only what the published files are
 * generated from, and no more of the site's pages than that.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { MAX_PUBLISHED_SNAPSHOT_BYTES } from "@/lib/accounts/data";
import { handlePublish } from "@/lib/api/publish";
import { agentJsonFiles } from "@/lib/generate/agent-json";
import { generateNetwork } from "@/lib/generate/network";
import { agentSnapshot, type Snapshot } from "@/lib/snapshot/types";
import { crawlFixtureSnapshots, SITES, type SiteName } from "../helpers/fixture-snapshots";
import { accountCookie, postRequest, testDeps } from "../helpers/server-deps";
import { HOST, listedAnalysis, snapshotOf, verifiedClaim } from "./setup";

let snapshots: Map<SiteName, Snapshot>;
beforeAll(async () => {
  snapshots = await crawlFixtureSnapshots();
}, 60_000);

const names = Object.keys(SITES) as SiteName[];
const files = (snapshot: Parameters<typeof agentSnapshot>[0]) => agentJsonFiles(generateNetwork({ snapshot, target: "bundle" }));

/** Publishes `snapshot` through the API and returns the stored snapshot as it is. */
async function storedAfterPublish(snapshot: Snapshot) {
  const d = testDeps();
  const cookie = await accountCookie(d);
  await verifiedClaim(d, undefined, snapshot.host);
  await listedAnalysis(d, { snapshot });
  const res = await handlePublish(postRequest("/api/publish", { host: snapshot.host }, { cookie }), d);
  expect(res.status).toBe(200);
  return (await d.accounts.getPublicSnapshot(snapshot.host))!.snapshot;
}

describe("the stored snapshot", () => {
  // Fails if a publication keeps any other field of the full snapshot: links, forms, JSON-LD, headers, probe bodies or per-page records.
  it.each(names)("%s: holds exactly the fields the published files need", async (name) => {
    const stored = await storedAfterPublish(snapshots.get(name)!);
    expect(Object.keys(stored).sort()).toEqual(["fetchedAt", "host", "pages", "records", "source"]);
    expect(stored.pages.length).toBeGreaterThan(0);
    for (const p of stored.pages) expect(Object.keys(p).sort()).toEqual(["noindex", "text", "title", "url"]);
    expect(stored.records).toEqual(snapshots.get(name)!.records);
  });

  // Fails if a page marked noindex is kept: its text is in no published file.
  it("leaves out pages marked noindex, with their text", async () => {
    const base = snapshotOf(HOST, "2026-11-20T08:00:00.000Z", "Public text");
    const full: Snapshot = { ...base, pages: [...base.pages, { ...base.pages[0]!, url: `https://${HOST}/private`, text: "Secret member text", noindex: true }] };
    const stored = await storedAfterPublish(full);
    expect(JSON.stringify(stored)).not.toContain("Secret member text");
    expect(stored.pages.map((p) => p.text)).toEqual(["Public text"]);
  });

  // Fails if the stored form loses anything the manifest, the network or the site content is made of.
  it.each(names)("%s: the manifest, the network and the site content are byte-identical to the full snapshot's", async (name) => {
    const full = snapshots.get(name)!;
    const fromStored = files(await storedAfterPublish(full));
    expect(fromStored).toEqual(files(full));
    expect(Object.keys(fromStored)).toHaveLength(5);
  });

  // Fails if the size limit counts parts that are not stored.
  it("the size limit counts the stored form", async () => {
    const page = snapshotOf(HOST, "2026-11-20T08:00:00.000Z");
    const big: Snapshot = { ...page, probes: { ...page.probes, robots: { ...page.probes.robots, body: "x".repeat(MAX_PUBLISHED_SNAPSHOT_BYTES) } } };
    const stored = await storedAfterPublish(big);
    expect(Buffer.byteLength(JSON.stringify(stored))).toBeLessThan(1000);
  });
});
