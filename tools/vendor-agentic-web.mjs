#!/usr/bin/env node
// Vendors the agentic-web browser runtime, scripts and templates into this
// repository and verifies the vendored copy against its manifest.
//
//   node tools/vendor-agentic-web.mjs sync --source <clone> --commit <sha> [--root <dir>]
//   node tools/vendor-agentic-web.mjs verify [--root <dir>]
//
// The clone is treated as data only: files are read and copied, nothing in it
// is executed. Git is called with fsmonitor and hooks disabled.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";

const SOURCE_URL = "https://github.com/cognizant-ai-labs/agentic-web";
const SKILL = "skills/agentify-website";
const MANIFEST = "vendor/agentic-web.json";

// Destination roots owned entirely by the vendored copy.
const ROOTS = ["public/runtime", "tools/agentic-web", "public/preview-assets"];

// [upstream path relative to SKILL, destination path relative to root]
const COPIES = [
  ["runtime", "public/runtime"],
  ["runtime", "tools/agentic-web/runtime"],
  ["scripts", "tools/agentic-web/scripts"],
  ["templates", "tools/agentic-web/templates"],
  ["templates/content-actions.js", "public/preview-assets/content-actions.js"],
  ["templates/bridge", "public/preview-assets/bridge"],
];

class UsageError extends Error {}

function fail(message) {
  console.error(`vendor-agentic-web: ${message}`);
  process.exit(1);
}

function toPosix(path) {
  return path.split(sep).join("/");
}

function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

// Lists regular files under dir (relative POSIX paths). Refuses symlinks and
// other special files so a copy can never escape the destination.
function listFiles(dir) {
  const out = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(toPosix(relative(dir, full)));
      else throw new UsageError(`refusing non-regular file ${full}`);
    }
  };
  walk(dir);
  return out.sort();
}

function git(clone, args) {
  return execFileSync(
    "git",
    ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-C", clone, ...args],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
}

function sync(root, sourceArg, commit) {
  if (!sourceArg) throw new UsageError("sync needs --source <clone>");
  if (!commit) throw new UsageError("sync needs --commit <sha>");
  const clone = resolve(sourceArg);
  if (!existsSync(clone)) fail(`source clone not found: ${clone}`);

  let head;
  try {
    head = git(clone, ["rev-parse", "HEAD"]);
  } catch (error) {
    fail(`cannot read HEAD of ${clone}: ${String(error.stderr ?? error.message).trim()}`);
  }
  if (head !== commit) {
    fail(`clone HEAD ${head} does not match the requested commit ${commit}; check out ${commit} in ${clone} first`);
  }
  const dirty = git(clone, ["status", "--porcelain", "--untracked-files=all"]);
  if (dirty) fail(`clone ${clone} has local changes or untracked files; vendor only a clean checkout:\n${dirty}`);
  const commitDate = git(clone, ["log", "-1", "--format=%cI", "HEAD"]);

  const skill = join(clone, SKILL);
  // Check every source before touching the destination.
  for (const [src] of COPIES) {
    const from = join(skill, src);
    if (!existsSync(from)) fail(`missing upstream path ${SKILL}/${src}`);
    const stat = lstatSync(from);
    if (stat.isDirectory()) listFiles(from);
    else if (!stat.isFile()) throw new UsageError(`refusing non-regular file ${from}`);
  }

  for (const dest of ROOTS) rmSync(join(root, dest), { recursive: true, force: true });

  const files = {};
  for (const [src, dest] of COPIES) {
    const from = join(skill, src);
    const pairs = lstatSync(from).isDirectory()
      ? listFiles(from).map((rel) => [join(from, rel), `${dest}/${rel}`])
      : [[from, dest]];
    for (const [file, destRel] of pairs) {
      const target = join(root, destRel);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(file, target);
      files[destRel] = sha256File(target);
    }
  }

  const sorted = Object.fromEntries(Object.keys(files).sort().map((key) => [key, files[key]]));
  const manifest = { source: SOURCE_URL, commit, commitDate, syncedAt: new Date().toISOString(), files: sorted };
  const manifestPath = join(root, MANIFEST);
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`vendor-agentic-web: synced ${Object.keys(sorted).length} files from ${commit} to ${ROOTS.join(", ")}`);
}

function verify(root) {
  const manifestPath = join(root, MANIFEST);
  if (!existsSync(manifestPath)) fail(`manifest not found: ${MANIFEST}; run the sync first`);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    fail(`cannot parse ${MANIFEST}: ${error.message}`);
  }
  if (!manifest || typeof manifest.files !== "object" || manifest.files === null) {
    fail(`${MANIFEST} has no "files" map`);
  }

  const problems = [];
  const recorded = manifest.files;
  for (const path of Object.keys(recorded).sort()) {
    const file = join(root, path);
    if (!existsSync(file) || !lstatSync(file).isFile()) problems.push(`missing: ${path}`);
    else if (sha256File(file) !== recorded[path]) problems.push(`changed: ${path}`);
  }
  for (const dest of ROOTS) {
    const dir = join(root, dest);
    if (!existsSync(dir)) continue;
    for (const rel of listFiles(dir)) {
      const path = `${dest}/${rel}`;
      if (!Object.hasOwn(recorded, path)) problems.push(`extra: ${path}`);
    }
  }

  if (problems.length > 0) {
    for (const line of problems) console.error(line);
    fail(`${problems.length} vendored file problem(s) against ${MANIFEST} (commit ${manifest.commit})`);
  }
  console.log(`vendor-agentic-web: OK, ${Object.keys(recorded).length} files match ${MANIFEST} (commit ${manifest.commit})`);
}

function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      source: { type: "string" },
      commit: { type: "string" },
      root: { type: "string" },
    },
  });
  const [command, ...rest] = positionals;
  if (rest.length > 0) throw new UsageError(`unexpected arguments: ${rest.join(" ")}`);
  const root = resolve(values.root ?? process.cwd());
  if (command === "sync") sync(root, values.source, values.commit);
  else if (command === "verify") verify(root);
  else throw new UsageError(`unknown command ${command ?? "(none)"}; use sync or verify`);
}

try {
  main();
} catch (error) {
  fail(error instanceof UsageError || error?.code === "ERR_PARSE_ARGS_UNKNOWN_OPTION" ? error.message : error.stack ?? String(error));
}
