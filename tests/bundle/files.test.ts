import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { bundleFiles } from "@/lib/bundle/files";
import type { NetworkConfig, PreviewManifest } from "@/lib/generate/network";
import type { Snapshot } from "@/lib/snapshot/types";
import { INJECTION } from "../fixtures/sites";
import { crawlFixtureSnapshots, type SiteName } from "../helpers/fixture-snapshots";

let snapshots: Map<SiteName, Snapshot>;
beforeAll(async () => { snapshots = await crawlFixtureSnapshots(); }, 60_000);

async function unpack(snapshot: Snapshot) {
  const { entries, topFolder } = await bundleFiles(snapshot);
  return new Map(entries.map(({ path, bytes }) => {
    expect(path.startsWith(topFolder + "/")).toBe(true);
    return [path.slice(topFolder.length + 1), bytes] as const;
  }));
}

describe("self-hosted bundle files", () => {
  it("ships the complete runtime and unchanged actions, bridge and stylesheet", async () => {
    const files = await unpack(snapshots.get("bakery")!);
    const runtime = "public/runtime";
    const diskFiles = (await readdir(runtime, { recursive: true, withFileTypes: true }))
      .filter(entry => entry.isFile())
      .map(entry => path.relative(runtime, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"));
    expect([...files.keys()].filter(name => name.startsWith("site/runtime/")).sort()).toEqual(diskFiles.map(name => "site/runtime/" + name).sort());
    for (const name of diskFiles) {
      expect(files.get("site/runtime/" + name)?.equals(await readFile(path.join(runtime, name))), name).toBe(true);
    }
    for (const [file, source] of [
      ["content-actions.js", "public/preview-assets/content-actions.js"],
      ["assistant/assistant.css", "tools/agentic-web/templates/assistant.css"],
      ["bridge/action-bridge.html", "tools/agentic-web/templates/bridge/action-bridge.html"],
    ] as const) expect(files.get("site/" + file)?.equals(await readFile(source)), file).toBe(true);
  });

  it("lists each installed path before the install steps and keeps hosting configuration separate", async () => {
    const snapshot = snapshots.get("bakery")!;
    const files = await unpack(snapshot);
    const readme = files.get("README.md")!.toString();
    expect(readme).toMatch(/for a site you own/i);
    expect(readme.match(/^## .+$/gm)).toEqual(["## Before you copy", "## Install", "## What visitors need", "## What data leaves the page", "## Keep it current", "## Get help"]);
    const beforeInstall = readme.split(/^## Install\s*$/m)[0]!;
    expect(beforeInstall).toContain("Before you copy");
    for (const directory of ["runtime/", "bridge/", "assistant/"]) expect(beforeInstall).toContain("`" + directory + "`");
    expect(beforeInstall).toContain("already a file");
    expect(beforeInstall).toContain("existing `.well-known/` directory");
    for (const [name, bytes] of files) {
      if (!name.startsWith("site/")) continue;
      expect(beforeInstall).toContain(name.slice("site/".length));
      expect(name).not.toMatch(/\/(?:\.htaccess|_headers|vercel\.json)$/);
      expect(bytes.includes("/api/inference"), name).toBe(false);
      expect(bytes.includes("thecreativetoken.com"), name).toBe(false);
    }
    for (const name of ["hosting/_headers", "hosting/htaccess-snippet.txt", "hosting/vercel-headers.json"]) {
      expect(files.has(name), name).toBe(true);
    }
    expect(readme).toContain("retrofit@thecreativetoken.com");
    expect(readme).toContain("runtime/LICENSE.txt");
    expect(readme).toContain("Otari");
    const date = snapshot.fetchedAt.slice(0, 10);
    expect(readme).toContain(date);
    expect(readme).toContain(snapshot.host);
    expect(JSON.parse(files.get("site/links.json")!.toString())).toEqual({ version: 1, networks: {} });
  });

  it("points the assistant at the site root and dates its page, greeting and instructions", async () => {
    const snapshot = snapshots.get("bakery")!;
    const date = snapshot.fetchedAt.slice(0, 10);
    const files = await unpack(snapshot);
    const html = files.get("site/assistant/index.html")!.toString();
    const script = files.get("site/assistant/site.js")!.toString();
    expect(html).toContain(snapshot.host);
    expect(html).toContain(date);
    expect(html).toMatch(/type="module" src="(?:\.\/)?site\.js"/);
    expect(script).toContain(`I answer questions about ${snapshot.host} from its public pages, saved on ${date}.`);
    expect(script).toContain("needs your AI provider key");
    expect(script).toContain("../runtime/index.js");
    expect(script).not.toContain("./script.js");
    expect(script).not.toContain("DIALOGS");
    const manifest: PreviewManifest = JSON.parse(files.get("site/agent-manifest.json")!.toString());
    const network: NetworkConfig = JSON.parse(files.get("site/" + manifest.networks[0]!.name + ".network.json")!.toString());
    expect(network.tools[0]!.instructions).toContain(snapshot.host);
    expect(network.tools[0]!.instructions).toContain(date);
  });

  it("gives each hosting format the public discovery paths and the sandbox worker policy", async () => {
    const files = await unpack(snapshots.get("bakery")!);
    const manifest: PreviewManifest = JSON.parse(files.get("site/agent-manifest.json")!.toString());
    const cors = ["/agent-manifest.json", "/" + manifest.networks[0]!.name + ".network.json", "/links.json", "/agent-mcp.json", "/.well-known/nsdeploy.json", "/.well-known/nsdeploy-agent.json"];
    const vercel: { headers: { source: string; headers: { key: string; value: string }[] }[] } = JSON.parse(files.get("hosting/vercel-headers.json")!.toString());
    const paths = vercel.headers.filter(rule => rule.headers.some(h => h.key === "Access-Control-Allow-Origin" && h.value === "*")).map(rule => rule.source);
    expect(paths.sort()).toEqual(cors.toSorted());
    const apache = files.get("hosting/htaccess-snippet.txt")!.toString();
    const netlify = files.get("hosting/_headers")!.toString();
    for (const path of cors) {
      expect(netlify).toContain(path + "\n  Access-Control-Allow-Origin: *");
      expect(apache).toContain(path.replaceAll(".", "\\."));
    }
    expect(apache).toContain('Access-Control-Allow-Origin "*"');
    const worker = "/runtime/sandbox-worker.js";
    expect(vercel.headers.find(rule => rule.source === worker)?.headers).toContainEqual({
      key: "Content-Security-Policy", value: expect.stringContaining("connect-src 'none'"),
    });
    expect(netlify).toContain(worker + "\n  Content-Security-Policy:");
    expect(apache).toContain(worker.replaceAll(".", "\\."));
    expect(apache).toContain("connect-src 'none'");
  });

  it("keeps hostile page text in the site content, away from code, documentation and instructions", async () => {
    const files = await unpack(snapshots.get("hostile")!);
    expect(files.get("site/site-content.json")!.toString()).toContain(INJECTION);
    for (const [name, bytes] of files) {
      if (name !== "site/site-content.json") expect(bytes.includes(INJECTION), name).toBe(false);
    }
  });

  it("makes portable download names for ports and long valid hosts", async () => {
    const snapshot = snapshots.get("bakery")!;
    const date = snapshot.fetchedAt.slice(0, 10);
    expect((await bundleFiles({ ...snapshot, host: "shop.test:8080" })).topFolder).toBe(`retrofit-shop.test-8080-${date}`);
    const host = Array(4).fill("a".repeat(62)).join(".");
    const { topFolder } = await bundleFiles({ ...snapshot, host });
    expect(Buffer.byteLength(topFolder + ".zip")).toBeLessThanOrEqual(255);
    expect(topFolder).toContain(date);
  });
});
