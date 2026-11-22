import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { beforeAll, expect, it } from "vitest";
import { bundleFiles } from "@/lib/bundle/files";
import type { PreviewManifest } from "@/lib/generate/network";
import type { Snapshot } from "@/lib/snapshot/types";
import { crawlFixtureSnapshots, SITES, type SiteName } from "../helpers/fixture-snapshots";

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

it("proves the organizer rejects a front agent that calls a missing tool", async () => {
  await compareWithOrganizer(snapshots.get("bakery")!, true);
});
