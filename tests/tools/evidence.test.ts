import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("../../tools/evidence.mjs", import.meta.url));

// Git variables from a surrounding hook or worktree must not redirect the temporary repository.
const cleanEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
) as NodeJS.ProcessEnv;

let root: string;

function git(...args: string[]): string {
  const result = spawnSync("git", args, { cwd: root, env: cleanEnv, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function evidence(command: string) {
  return spawnSync(process.execPath, [script, command, "--root", root], {
    env: cleanEnv,
    encoding: "utf8",
  });
}

const current = () => path.join(root, ".local/evidence/current");
const readAttempt = () => JSON.parse(fs.readFileSync(path.join(current(), "attempt.json"), "utf8"));

// Linux stamps files with a coarse clock that can trail Date.now() by a few milliseconds.
function pause(ms: number) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "retrofit-evidence-")));
  git("init", "-q");
  git("config", "user.email", "test@example.test");
  git("config", "user.name", "Evidence Test");
  git("config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(root, ".gitignore"), ".local/\n");
  fs.writeFileSync(path.join(root, "tracked.txt"), "one\n");
  git("add", ".");
  git("commit", "-q", "-m", "initial");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("evidence begin", () => {
  it("writes the attempt identity for a clean tree", () => {
    const before = Date.now();
    const result = evidence("begin");
    expect(result.status, result.stderr).toBe(0);
    const attempt = readAttempt();
    expect(attempt.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(attempt.commit).toBe(git("rev-parse", "HEAD"));
    expect(attempt.tree).toBe(git("rev-parse", "HEAD^{tree}"));
    expect(attempt.startedAtMs).toBeGreaterThanOrEqual(before);
    expect(Date.parse(attempt.startedAt)).toBe(attempt.startedAtMs);
  });

  it("refuses a modified tracked file", () => {
    fs.writeFileSync(path.join(root, "tracked.txt"), "changed\n");
    const result = evidence("begin");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("tracked.txt");
    expect(fs.existsSync(path.join(current(), "attempt.json"))).toBe(false);
  });

  it("refuses an untracked file", () => {
    fs.writeFileSync(path.join(root, "stray.txt"), "new\n");
    const result = evidence("begin");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("stray.txt");
    expect(fs.existsSync(path.join(current(), "attempt.json"))).toBe(false);
  });

  it("removes reports from an earlier attempt", () => {
    expect(evidence("begin").status).toBe(0);
    const firstNonce = readAttempt().nonce;
    fs.mkdirSync(path.join(current(), "coverage"));
    fs.writeFileSync(path.join(current(), "coverage/summary.json"), "{}");
    fs.writeFileSync(path.join(current(), "vitest-unit.json"), "{}");

    expect(evidence("begin").status).toBe(0);
    expect(fs.readdirSync(current())).toEqual(["attempt.json"]);
    expect(readAttempt().nonce).not.toBe(firstNonce);
  });
});

describe("evidence seal", () => {
  it("records the hash and size of every report", () => {
    expect(evidence("begin").status).toBe(0);
    pause(30);
    const top = '{"numTotalTests":3}';
    const nested = '{"total":{"statements":{"pct":91}}}';
    fs.writeFileSync(path.join(current(), "vitest-unit.json"), top);
    fs.mkdirSync(path.join(current(), "coverage"));
    fs.writeFileSync(path.join(current(), "coverage/coverage-summary.json"), nested);

    const result = evidence("seal");
    expect(result.status, result.stderr).toBe(0);
    const { seal } = readAttempt();
    expect(Number.isNaN(Date.parse(seal.sealedAt))).toBe(false);
    const byPath = Object.fromEntries(seal.reports.map((r: { path: string }) => [r.path, r]));
    expect(Object.keys(byPath).sort()).toEqual(["coverage/coverage-summary.json", "vitest-unit.json"]);
    const sha = (text: string) => createHash("sha256").update(text).digest("hex");
    expect(byPath["vitest-unit.json"].sha256).toBe(sha(top));
    expect(byPath["vitest-unit.json"].size).toBe(Buffer.byteLength(top));
    expect(byPath["coverage/coverage-summary.json"].sha256).toBe(sha(nested));
    expect(byPath["coverage/coverage-summary.json"].size).toBe(Buffer.byteLength(nested));
    const mtimeMs = fs.statSync(path.join(current(), "vitest-unit.json")).mtimeMs;
    expect(byPath["vitest-unit.json"].mtimeMs).toBe(mtimeMs);
  });

  it("refuses a report older than begin", () => {
    expect(evidence("begin").status).toBe(0);
    pause(30);
    fs.writeFileSync(path.join(current(), "fresh.json"), "{}");
    const stale = path.join(current(), "stale.json");
    fs.writeFileSync(stale, "{}");
    const old = new Date(readAttempt().startedAtMs - 60_000);
    fs.utimesSync(stale, old, old);

    const result = evidence("seal");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("stale.json");
    expect(result.stderr).not.toContain("fresh.json");
    expect(readAttempt().seal).toBeUndefined();
  });

  it("refuses when HEAD moved after begin", () => {
    expect(evidence("begin").status).toBe(0);
    pause(30);
    fs.writeFileSync(path.join(current(), "vitest-unit.json"), "{}");
    fs.writeFileSync(path.join(root, "tracked.txt"), "two\n");
    git("commit", "-q", "-am", "second");

    const result = evidence("seal");
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/HEAD/);
    expect(readAttempt().seal).toBeUndefined();
  });

  it("refuses when no report was written", () => {
    expect(evidence("begin").status).toBe(0);
    const result = evidence("seal");
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/no report/i);
    expect(readAttempt().seal).toBeUndefined();
  });

  it("refuses without an attempt", () => {
    const result = evidence("seal");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("attempt.json");
  });
});
