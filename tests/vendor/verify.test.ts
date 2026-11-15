import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const tool = fileURLToPath(new URL("../../tools/vendor-agentic-web.mjs", import.meta.url));

// Synthetic upstream layout. Paths are relative to skills/agentify-website/.
const upstream: Record<string, string> = {
  "runtime/index.js": "export const runtime = 1;\n",
  "runtime/generated/bundle.js": "var bundled = true;\n",
  "scripts/build.mjs": "// must never run\nprocess.exit(42);\n",
  "templates/site.js": "export const site = 1;\n",
  "templates/content-actions.js": "export const contentActions = [];\n",
  "templates/bridge/action-bridge.html": "<!doctype html><title>bridge</title>\n",
  "SKILL.md": "# not vendored\n",
};

// Every destination file the sync must produce, mapped to its upstream source.
const expected: Record<string, string> = {
  "public/runtime/index.js": "runtime/index.js",
  "public/runtime/generated/bundle.js": "runtime/generated/bundle.js",
  "tools/agentic-web/runtime/index.js": "runtime/index.js",
  "tools/agentic-web/runtime/generated/bundle.js": "runtime/generated/bundle.js",
  "tools/agentic-web/scripts/build.mjs": "scripts/build.mjs",
  "tools/agentic-web/templates/site.js": "templates/site.js",
  "tools/agentic-web/templates/content-actions.js": "templates/content-actions.js",
  "tools/agentic-web/templates/bridge/action-bridge.html": "templates/bridge/action-bridge.html",
  "public/preview-assets/content-actions.js": "templates/content-actions.js",
  "public/preview-assets/bridge/action-bridge.html": "templates/bridge/action-bridge.html",
};

let work: string;
let clone: string;
let root: string;
let head: string;

function git(args: string[], cwd: string): string {
  const result = spawnSync(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function run(...args: string[]) {
  const result = spawnSync(process.execPath, [tool, ...args, "--root", root], { encoding: "utf8" });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "retrofit-vendor-"));
  clone = join(work, "clone");
  root = join(work, "root");
  mkdirSync(root);
  for (const [path, content] of Object.entries(upstream)) {
    const file = join(clone, "skills/agentify-website", path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  git(["init", "-q"], clone);
  git(["add", "."], clone);
  git(["commit", "-q", "-m", "fixture"], clone);
  head = git(["rev-parse", "HEAD"], clone);
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

describe("vendor-agentic-web sync", () => {
  it("refuses a commit that is not the clone's HEAD and writes nothing", () => {
    const wrong = "0".repeat(40);
    const result = run("sync", "--source", clone, "--commit", wrong);

    expect(result.status).toBe(1);
    expect(result.output).toContain(wrong);
    expect(result.output).toContain(head);
    expect(existsSync(join(root, "vendor/agentic-web.json"))).toBe(false);
    expect(existsSync(join(root, "public/runtime"))).toBe(false);
  });

  it("copies exactly the vendored files and records their hashes", () => {
    mkdirSync(join(root, "public/runtime"), { recursive: true });
    writeFileSync(join(root, "public/runtime/stale.js"), "stale\n");

    const result = run("sync", "--source", clone, "--commit", head);
    expect(result.status, result.output).toBe(0);

    const manifest = JSON.parse(readFileSync(join(root, "vendor/agentic-web.json"), "utf8"));
    expect(manifest.source).toBe("https://github.com/cognizant-ai-labs/agentic-web");
    expect(manifest.commit).toBe(head);
    expect(manifest.commitDate).toBe(git(["log", "-1", "--format=%cI", "HEAD"], clone));
    expect(Number.isNaN(Date.parse(manifest.syncedAt))).toBe(false);

    const keys = Object.keys(manifest.files);
    expect(keys).toEqual(Object.keys(expected).sort());
    for (const [dest, src] of Object.entries(expected)) {
      expect(readFileSync(join(root, dest), "utf8")).toBe(upstream[src]);
      expect(manifest.files[dest]).toBe(sha256(upstream[src] ?? ""));
    }
    expect(existsSync(join(root, "public/runtime/stale.js"))).toBe(false);
    // The copied script must not have been executed (it would exit 42 and nothing else).
    expect(existsSync(join(root, "tools/agentic-web/SKILL.md"))).toBe(false);
  });
});

describe("vendor-agentic-web verify", () => {
  it("passes right after a sync", () => {
    expect(run("sync", "--source", clone, "--commit", head).status).toBe(0);

    const result = run("verify");
    expect(result.status, result.output).toBe(0);
    expect(result.output).toMatch(/OK/);
    expect(result.output).toContain(String(Object.keys(expected).length));
  });

  it("names the changed, extra and missing files on a tampered tree", () => {
    expect(run("sync", "--source", clone, "--commit", head).status).toBe(0);
    writeFileSync(join(root, "public/runtime/index.js"), "export const runtime = 2;\n");
    writeFileSync(join(root, "public/preview-assets/bridge/new.html"), "<p>added</p>\n");
    rmSync(join(root, "tools/agentic-web/scripts/build.mjs"));

    const result = run("verify");
    expect(result.status).toBe(1);
    expect(result.output).toContain("changed: public/runtime/index.js");
    expect(result.output).toContain("extra: public/preview-assets/bridge/new.html");
    expect(result.output).toContain("missing: tools/agentic-web/scripts/build.mjs");
    expect(result.output).not.toContain("changed: public/runtime/generated/bundle.js");
  });

  it("fails when the manifest is absent", () => {
    const result = run("verify");
    expect(result.status).toBe(1);
    expect(result.output).toContain("vendor/agentic-web.json");
  });
});
