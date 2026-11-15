import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateNetwork, type GeneratedPreview } from "@/lib/generate/network";
import type { Snapshot } from "@/lib/snapshot/types";
import { crawlFixtureSnapshots, PUBLIC_ORIGIN, SITES, type SiteName } from "./snapshots";

// The organizers' own build script is the oracle (research 2026-11-15-phase-4-entry.md §3).
const run = promisify(execFile);
const ROOT = path.resolve(__dirname, "../..");
const BUILD = path.join(ROOT, "tools/agentic-web/scripts/build_network.mjs");
const RUNTIME = path.join(ROOT, "tools/agentic-web/runtime");

let snapshots: Map<SiteName, Snapshot>;
const dirs: string[] = [];

beforeAll(async () => {
  snapshots = await crawlFixtureSnapshots();
}, 60_000);
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

/** Writes `<name>.hocon` (JSON content) and agent-manifest.json, then runs build_network.mjs without --check. */
async function build(g: { networkName: string; network: unknown; manifest: unknown }) {
  const dir = await mkdtemp(path.join(tmpdir(), "retrofit-oracle-"));
  dirs.push(dir);
  const hocon = path.join(dir, `${g.networkName}.hocon`);
  const manifest = path.join(dir, "agent-manifest.json");
  const out = path.join(dir, `${g.networkName}.network.json`);
  await writeFile(hocon, JSON.stringify(g.network, null, 2));
  await writeFile(manifest, JSON.stringify(g.manifest, null, 2));
  try {
    const r = await run(process.execPath, [BUILD, hocon, "--manifest", manifest, "--runtime", RUNTIME, "--out", out], { cwd: dir });
    return { code: 0, stdout: r.stdout, stderr: r.stderr, out };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? -1, stdout: err.stdout ?? "", stderr: err.stderr ?? "", out };
  }
}

describe("build_network.mjs accepts every generated network", () => {
  for (const name of Object.keys(SITES) as SiteName[]) {
    // Fails if the generated manifest or network breaks any build rule (linking, agent_mcp, bridge, sample_queries, front_man, hocon path).
    it(`${name}: exit 0, and the built network file equals the network the preview serves`, async () => {
      const g: GeneratedPreview = generateNetwork({ snapshot: snapshots.get(name)!, publicOrigin: PUBLIC_ORIGIN });
      const r = await build(g);
      expect(r.code, r.stdout + r.stderr).toBe(0);
      expect(JSON.parse(await readFile(r.out, "utf8"))).toEqual(g.network);
    }, 30_000);
  }
});

describe("build_network.mjs refuses an invalid network", () => {
  // Fails if the oracle run cannot fail (for example a wrong script path that exits 0), so the test above would prove nothing.
  it("a front man that names a missing tool exits non-zero", async () => {
    const g = generateNetwork({ snapshot: snapshots.get("bakery")!, publicOrigin: PUBLIC_ORIGIN });
    const network = structuredClone(g.network) as unknown as { tools: { tools: string[] }[] };
    network.tools[0]!.tools = ["content_specialist", "missing_agent"];
    const r = await build({ ...g, network });
    expect(r.code).not.toBe(0);
    expect(r.stdout + r.stderr).toContain("missing_agent");
  }, 30_000);
});
