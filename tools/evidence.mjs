#!/usr/bin/env node
// Binds gate reports to one verification attempt and one Git tree.
//
//   node tools/evidence.mjs begin [--root <dir>]
//   node tools/evidence.mjs seal  [--root <dir>]
//
// `begin` refuses a dirty tree, clears .local/evidence/current/ and writes attempt.json.
// `seal` hashes every report written since `begin` into attempt.json.
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const CURRENT = path.join(".local", "evidence", "current");
const ATTEMPT = "attempt.json";

class Refusal extends Error {}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  let root = process.cwd();
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === "--root" && rest[i + 1]) {
      root = path.resolve(rest[i + 1]);
      i += 1;
    } else {
      throw new Refusal(`unknown argument: ${rest[i]}`);
    }
  }
  return { command, root };
}

function git(root, ...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" });
}

function headIdentity(root) {
  return {
    commit: git(root, "rev-parse", "HEAD").trim(),
    tree: git(root, "rev-parse", "HEAD^{tree}").trim(),
  };
}

function begin(root) {
  // Explicit flag so a user's status.showUntrackedFiles=no cannot hide untracked files.
  const status = git(root, "status", "--porcelain", "--untracked-files=normal");
  if (status.trim() !== "") {
    throw new Refusal(`working tree is not clean; commit or remove these changes first:\n${status}`);
  }
  const identity = headIdentity(root);
  const current = path.join(root, CURRENT);
  fs.rmSync(current, { recursive: true, force: true });
  fs.mkdirSync(current, { recursive: true });
  const startedAtMs = Date.now();
  const attempt = {
    nonce: randomBytes(16).toString("hex"),
    commit: identity.commit,
    tree: identity.tree,
    startedAt: new Date(startedAtMs).toISOString(),
    startedAtMs,
  };
  fs.writeFileSync(path.join(current, ATTEMPT), `${JSON.stringify(attempt, null, 2)}\n`);
  console.log(`evidence attempt ${attempt.nonce} for ${attempt.commit}`);
}

function listReports(current, relative = "") {
  const entries = fs.readdirSync(path.join(current, relative), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const rel = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...listReports(current, rel));
    } else if (entry.isFile()) {
      if (rel !== ATTEMPT) files.push(rel);
    } else {
      throw new Refusal(`report is not a regular file: ${rel}`);
    }
  }
  return files;
}

function seal(root) {
  const current = path.join(root, CURRENT);
  const attemptPath = path.join(current, ATTEMPT);
  if (!fs.existsSync(attemptPath)) {
    throw new Refusal(`${path.join(CURRENT, ATTEMPT)} is missing; run begin first`);
  }
  const attempt = JSON.parse(fs.readFileSync(attemptPath, "utf8"));

  const identity = headIdentity(root);
  if (identity.commit !== attempt.commit || identity.tree !== attempt.tree) {
    throw new Refusal(
      `HEAD changed since begin (commit ${attempt.commit} -> ${identity.commit}, ` +
        `tree ${attempt.tree} -> ${identity.tree}); start a new attempt`,
    );
  }

  const reports = listReports(current)
    .sort()
    .map((rel) => {
      const full = path.join(current, rel);
      const bytes = fs.readFileSync(full);
      const { mtimeMs } = fs.statSync(full);
      return { path: rel, sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length, mtimeMs };
    });
  if (reports.length === 0) {
    throw new Refusal(`no report found in ${CURRENT}; nothing to seal`);
  }
  const stale = reports.filter((report) => report.mtimeMs < attempt.startedAtMs);
  if (stale.length > 0) {
    throw new Refusal(
      `reports older than begin (${attempt.startedAt}): ${stale.map((report) => report.path).join(", ")}`,
    );
  }

  attempt.seal = { sealedAt: new Date().toISOString(), reports };
  fs.writeFileSync(attemptPath, `${JSON.stringify(attempt, null, 2)}\n`);
  console.log(`sealed ${reports.length} reports for attempt ${attempt.nonce}`);
}

try {
  const { command, root } = parseArgs(process.argv.slice(2));
  if (command === "begin") begin(root);
  else if (command === "seal") seal(root);
  else throw new Refusal("usage: evidence.mjs <begin|seal> [--root <dir>]");
} catch (error) {
  console.error(`evidence: ${error instanceof Refusal ? error.message : error.stack ?? error}`);
  process.exit(1);
}
