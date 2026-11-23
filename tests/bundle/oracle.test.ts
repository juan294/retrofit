import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { beforeAll, expect, it } from "vitest";
import { bundleFiles } from "@/lib/bundle/files";
import type { PreviewManifest } from "@/lib/generate/network";
import { handlePublishedFile } from "@/lib/publish/files";
import type { Snapshot } from "@/lib/snapshot/types";
import { crawlFixtureSnapshots, SITES, type SiteName } from "../helpers/fixture-snapshots";
import { published, publishedFiles } from "../publish/setup";

const exec = promisify(execFile);
const builder = path.resolve("tools/agentic-web/scripts/build_network.mjs");
const runtime = path.resolve("tools/agentic-web/runtime");
let snapshots: Map<SiteName, Snapshot>;
beforeAll(async () => { snapshots = await crawlFixtureSnapshots(); }, 60_000);

async function compareWithOrganizer(snapshot: Snapshot, invalid = false) {
  const dir = await mkdtemp(path.join(tmpdir(), "retrofit-bundle-oracle-"));
  try {
    const { entries, topFolder } = await bundleFiles(snapshot);
    const site = path.join(dir, topFolder, "site");
    for (const entry of entries) {
      const target = path.join(dir, entry.path);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, entry.bytes);
    }
    const manifestBytes = await readFile(path.join(site, "agent-manifest.json"));
    const manifest = JSON.parse(manifestBytes.toString()) as PreviewManifest;
    const networkName = manifest.networks[0]!.name;
    const networkFile = networkName + ".network.json";
    const network = JSON.parse(await readFile(path.join(site, networkFile), "utf8"));
    if (invalid) network.tools[0].tools.push("missing_agent");
    const oracle = path.join(dir, "organizer");
    await mkdir(oracle);
    await writeFile(path.join(oracle, networkName + ".hocon"), JSON.stringify(network, null, 2));
    await writeFile(path.join(oracle, "agent-manifest.json"), manifestBytes);
    const build = exec(process.execPath, [builder, networkName + ".hocon", "--manifest", "agent-manifest.json", "--runtime", runtime, "--out", networkFile], { cwd: oracle });
    if (invalid) {
      await expect(build).rejects.toMatchObject({ code: 1, stdout: expect.stringContaining("missing_agent") });
      return;
    }
    await build;
    for (const file of [
      networkFile, "agent-mcp.json", ".well-known/nsdeploy.json", ".well-known/nsdeploy-agent.json",
      "bridge/action-bridge.html", "bridge/agent-manifest.json",
    ]) {
      expect((await readFile(path.join(site, file))).equals(await readFile(path.join(oracle, file))), file).toBe(true);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

it.each(Object.keys(SITES) as SiteName[])("matches the organizer's published bytes for %s", async name => {
  await compareWithOrganizer(snapshots.get(name)!);
});

// Phase 4. The files as /s/<host>/ serves them (src/lib/publish/files.ts), through the same build.
async function comparePublishedWithOrganizer(snapshot: Snapshot, tamper = false) {
  const { d } = await published(snapshot);
  const get = async (file: string) => {
    const res = await handlePublishedFile(d, snapshot.host, file.split("/"));
    expect(res.status, file).toBe(200);
    return Buffer.from(await res.arrayBuffer());
  };
  const dir = await mkdtemp(path.join(tmpdir(), "retrofit-publish-oracle-"));
  try {
    const manifestBytes = await get("agent-manifest.json");
    const manifest = JSON.parse(manifestBytes.toString()) as PreviewManifest;
    const networkName = manifest.networks[0]!.name;
    const networkFile = networkName + ".network.json";
    const network = JSON.parse((await get(networkFile)).toString());
    if (tamper) network.max_steps += 1;
    await writeFile(path.join(dir, networkName + ".hocon"), JSON.stringify(network, null, 2));
    await writeFile(path.join(dir, "agent-manifest.json"), manifestBytes);
    await exec(process.execPath, [builder, networkName + ".hocon", "--manifest", "agent-manifest.json", "--runtime", runtime, "--out", networkFile], { cwd: dir });
    const same = async (file: string) => (await get(file)).equals(await readFile(path.join(dir, file)));
    expect(await same(networkFile)).toBe(!tamper);
    for (const file of ["bridge/action-bridge.html", "bridge/agent-manifest.json"]) expect(await same(file), file).toBe(true);
    // The build reads the served manifest as it is and does not rewrite it.
    expect((await readFile(path.join(dir, "agent-manifest.json"))).equals(manifestBytes)).toBe(true);
    for (const [file] of publishedFiles(snapshot.host)) {
      expect((await get(file)).includes("/api/inference"), file).toBe(false);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

it.each(Object.keys(SITES) as SiteName[])("the published files of %s match the organizer's bytes and name no Retrofit inference route", async name => {
  await comparePublishedWithOrganizer(snapshots.get(name)!);
});

it("proves the published comparison sees a changed network", async () => {
  await comparePublishedWithOrganizer(snapshots.get("bakery")!, true);
});

it("proves the organizer rejects a front agent that calls a missing tool", async () => {
  await compareWithOrganizer(snapshots.get("bakery")!, true);
});
