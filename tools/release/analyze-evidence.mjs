#!/usr/bin/env node
// Decides whether a release candidate's evidence is complete, current and bound to that candidate.
//
//   node tools/release/analyze-evidence.mjs <candidate-commit>
//        [--production <evidence-dir>] [--root <dir>]
//        [--accept-failed-check <name> ... --reason <text>]
//
// Exit 0: accepted. Exit 1: rejected; every reason is listed. Exit 2: usage or input error.
//
// Local mode reads .rpi/local/verification.json (written by .rpi/scripts/rpi-verify.py) and the
// reports sealed by tools/evidence.mjs in .local/evidence/current/. Production mode also reads
// <evidence-dir>/deployment.json, <evidence-dir>/run.json (the evidence run's runId, which every
// report must carry) and every other <evidence-dir>/*.json case report.
//
// Gate database teardown marker: the gate database tool (`pnpm test:db`) writes its log to
// .local/evidence/current/gate-db.log and writes the line `GATE-DB TEARDOWN COMPLETE` only after
// it has stopped the retrofit-gate stack, verified removal and deleted its receipt. When
// .rpi/policy.json declares a check that runs `test:db`, the log and vitest-db.json are required;
// a log that is present is always checked.
//
// --accept-failed-check accepts a non-zero exit only for checks in ENVIRONMENT_FAILURE_ALLOWLIST,
// only with a non-blank --reason, and prints every accepted exception in the report. It never
// excuses a missing check.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const GATE_DB_TEARDOWN_MARKER = "GATE-DB TEARDOWN COMPLETE";
// Checks that can fail for a reason outside the candidate (machine state, sibling repositories).
const ENVIRONMENT_FAILURE_ALLOWLIST = ["rpi-installation"];
const COVERAGE_BAR = { statements: 80, branches: 70 };
const CURRENT = path.join(".local", "evidence", "current");
const VERIFICATION = path.join(".rpi", "local", "verification.json");
const SUITES = [
  { name: "unit", kind: "vitest", report: "vitest-unit.json" },
  { name: "perf", kind: "vitest", report: "vitest-perf.json" },
  { name: "db", kind: "vitest", report: "vitest-db.json", declaredBy: "test:db" },
  { name: "playwright", kind: "playwright", report: "playwright.json" },
];
const USAGE =
  "usage: analyze-evidence.mjs <candidate-commit> [--production <evidence-dir>] [--root <dir>] " +
  "[--accept-failed-check <name> ... --reason <text>]";

class UsageError extends Error {}

function parseArgs(argv) {
  const options = { root: process.cwd(), production: null, accept: [], reason: null, candidate: null };
  const value = (i, flag) => {
    if (i + 1 >= argv.length) throw new UsageError(`${flag} needs a value\n${USAGE}`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--root") options.root = path.resolve(value(i++, arg));
    else if (arg === "--production") options.production = value(i++, arg);
    else if (arg === "--accept-failed-check") options.accept.push(value(i++, arg));
    else if (arg === "--reason") options.reason = value(i++, arg);
    else if (arg.startsWith("--")) throw new UsageError(`unknown argument: ${arg}\n${USAGE}`);
    else if (options.candidate === null) options.candidate = arg;
    else throw new UsageError(`unexpected argument: ${arg}\n${USAGE}`);
  }
  if (!options.candidate) throw new UsageError(USAGE);
  for (const name of options.accept) {
    if (!ENVIRONMENT_FAILURE_ALLOWLIST.includes(name)) {
      throw new UsageError(
        `${name} is not in the environment-failure allowlist (${ENVIRONMENT_FAILURE_ALLOWLIST.join(", ")})`,
      );
    }
  }
  if (options.accept.length > 0 && !options.reason?.trim()) {
    throw new UsageError("--accept-failed-check needs --reason <text> that says why the failure is accepted");
  }
  if (options.accept.length === 0 && options.reason !== null) {
    throw new UsageError("--reason is only valid with --accept-failed-check");
  }
  if (options.production) options.production = path.resolve(options.root, options.production);
  return options;
}

function resolveCandidate(root, candidate) {
  try {
    const run = (rev) =>
      execFileSync("git", ["rev-parse", "--verify", "--quiet", rev], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    return { commit: run(`${candidate}^{commit}`), tree: run(`${candidate}^{tree}`) };
  } catch {
    throw new UsageError(`cannot resolve candidate commit ${candidate} in ${root}`);
  }
}

/** Reads JSON, or records why it cannot and returns null. */
function readJson(file, label, reject) {
  if (!fs.existsSync(file)) {
    reject(`${label} is missing`);
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    reject(`${label} is not valid JSON: ${error.message}`);
    return null;
  }
}

function listFiles(dir, relative = "") {
  return fs.readdirSync(path.join(dir, relative), { withFileTypes: true }).flatMap((entry) => {
    const rel = relative ? `${relative}/${entry.name}` : entry.name;
    return entry.isDirectory() ? listFiles(dir, rel) : [rel];
  });
}

const sameArgv = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i]);

function checkBinding(ctx, verification, attempt) {
  const { candidate, reject } = ctx;
  if (verification) {
    if (verification.suite !== "ci-equivalent") {
      reject("binding", `verification.json suite is ${JSON.stringify(verification.suite)}, not the full "ci-equivalent" selection`);
    }
    const identityCommit = verification.identity?.commit;
    if (identityCommit !== candidate.commit) {
      reject("binding", `verification.json identity commit ${identityCommit} differs from the candidate ${candidate.commit}`);
    }
    if (verification.identity_unchanged !== true) {
      reject("binding", "verification.json identity_unchanged is not true: candidate inputs changed during the gate");
    }
    if (verification.environment_unchanged === false) {
      reject("binding", "verification.json environment_unchanged is false: the runtime changed during the gate");
    }
  }
  if (!attempt) return;
  if (attempt.commit !== candidate.commit) {
    reject("binding", `attempt.json commit ${attempt.commit} differs from the candidate ${candidate.commit}`);
  }
  if (attempt.tree !== candidate.tree) {
    reject("binding", `attempt.json tree ${attempt.tree} differs from the candidate tree ${candidate.tree}`);
  }
  if (!verification) return;
  if (attempt.commit !== verification.identity?.commit) {
    reject("binding", `attempt.json commit ${attempt.commit} differs from verification.json identity commit ${verification.identity?.commit}`);
  }
  const attemptStart = Date.parse(attempt.startedAt);
  const gateStart = Date.parse(verification.started_at);
  if (!Number.isFinite(attemptStart) || !Number.isFinite(gateStart)) {
    reject("binding", `cannot compare attempt.json startedAt ${attempt.startedAt} with verification.json started_at ${verification.started_at}`);
  } else if (attemptStart < gateStart) {
    reject("binding", `attempt.json started at ${attempt.startedAt}, before verification.json started_at ${verification.started_at}: the reports belong to an earlier run`);
  }
  const sealedAt = Date.parse(attempt.seal?.sealedAt);
  const gateEnd = Date.parse(verification.recorded_at);
  if (Number.isFinite(sealedAt) && Number.isFinite(gateEnd) && sealedAt > gateEnd) {
    reject("binding", `attempt.json was sealed at ${attempt.seal.sealedAt}, after verification.json recorded_at ${verification.recorded_at}`);
  }
}

/** Verifies the seal and returns the set of sealed report paths whose bytes match. */
function checkSeal(ctx, attempt, current) {
  const { reject } = ctx;
  const sealed = new Set();
  if (!attempt) return sealed;
  if (!attempt.seal || !Array.isArray(attempt.seal.reports)) {
    reject("seal", "attempt.json has no seal: the gate did not finish with evidence:seal");
    return sealed;
  }
  const listed = new Map(attempt.seal.reports.map((report) => [report.path, report]));
  for (const rel of listFiles(current).sort()) {
    if (rel !== "attempt.json" && !listed.has(rel)) reject("seal", `${rel} is not listed in the seal`);
  }
  for (const [rel, report] of listed) {
    const file = path.join(current, rel);
    if (!fs.existsSync(file)) {
      reject("seal", `sealed report ${rel} is missing`);
      continue;
    }
    const sha256 = createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    if (sha256 !== report.sha256) reject("seal", `${rel} sha256 ${sha256} differs from the seal ${report.sha256}`);
    else sealed.add(rel);
  }
  return sealed;
}

function checkRequiredChecks(ctx, policy, verification, accept, reason) {
  const { reject } = ctx;
  const declared = Array.isArray(policy?.verification_checks) ? policy.verification_checks : [];
  if (policy && declared.length === 0) reject("check", ".rpi/policy.json declares no verification_checks");
  const ran = new Map((Array.isArray(verification?.checks) ? verification.checks : []).map((check) => [check.name, check]));
  for (const check of declared) {
    const result = ran.get(check.name);
    if (!result) {
      reject("check", `required check ${check.name} is missing from verification.json`);
      continue;
    }
    if (!sameArgv(result.argv, check.argv)) {
      reject("check", `required check ${check.name} ran ${JSON.stringify(result.argv)}, not the declared ${JSON.stringify(check.argv)}`);
    }
    if (result.exit_code === 0) continue;
    if (accept.includes(check.name)) {
      ctx.exceptions.push(`required check ${check.name} exited ${result.exit_code}; reason: ${reason}`);
    } else {
      reject("check", `required check ${check.name} exited ${result.exit_code}`);
    }
  }
  for (const name of accept) {
    if (ran.get(name)?.exit_code === 0) ctx.notes.push(`exception for ${name} was not used: the check passed`);
  }
  return declared;
}

const fileMatches = (root, reportFile, wanted) =>
  reportFile === wanted || reportFile === path.join(root, wanted) || reportFile.endsWith(`/${wanted}`);

/** Flattens a report into [{file, title, outcome}] with outcome passed | failed | skipped. */
function readTests(kind, report) {
  const tests = [];
  if (kind === "vitest") {
    for (const file of report.testResults ?? []) {
      for (const assertion of file.assertionResults ?? []) {
        const outcome = assertion.status === "passed" ? "passed" : assertion.status === "failed" ? "failed" : "skipped";
        tests.push({ file: file.name, title: assertion.fullName, outcome });
      }
    }
    return tests;
  }
  const walk = (suite, ancestors) => {
    for (const spec of suite.specs ?? []) {
      const title = [...ancestors, spec.title].join(" ");
      for (const test of spec.tests ?? []) {
        const skipped =
          test.status === "skipped" || test.expectedStatus === "skipped" || (test.results ?? []).some((r) => r.status === "skipped");
        const outcome = skipped ? "skipped" : test.status === "expected" || test.status === "flaky" ? "passed" : "failed";
        tests.push({ file: spec.file, title, outcome });
      }
    }
    for (const child of suite.suites ?? []) walk(child, [...ancestors, child.title]);
  };
  // The top-level suite is the file; its title is not part of the test title.
  for (const fileSuite of report.suites ?? []) walk(fileSuite, []);
  return tests;
}

function checkSuites(ctx, declared, sealed, current, required) {
  const { reject, root } = ctx;
  const counts = {};
  for (const suite of SUITES) {
    const isDeclared = !suite.declaredBy || declared.some((check) => (check.argv ?? []).includes(suite.declaredBy));
    const present = fs.existsSync(path.join(current, suite.report));
    const wanted = required.filter((test) => test.suite === suite.name);
    if (!isDeclared && !present && wanted.length === 0) continue;
    if (!present || !sealed.has(suite.report)) {
      if (!present) reject("suite", `suite ${suite.name} report ${suite.report} is missing`);
      if (wanted.length > 0) reject("required-test", `${wanted.length} required ${suite.name} tests cannot be checked without a sealed ${suite.report}`);
      continue;
    }
    const report = readJson(path.join(current, suite.report), suite.report, (m) => reject("suite", m));
    if (!report) continue;
    const tests = readTests(suite.kind, report);
    const passed = tests.filter((t) => t.outcome === "passed").length;
    const failed = tests.filter((t) => t.outcome === "failed").length;
    counts[suite.name] = passed;
    if (passed === 0) reject("suite", `suite ${suite.name} has zero passing tests`);
    if (failed > 0) reject("suite", `suite ${suite.name} has ${failed} failed test${failed === 1 ? "" : "s"}`);
    for (const want of wanted) {
      const found = tests.filter((t) => t.title === want.title && fileMatches(root, t.file, want.file));
      const label = `${want.file} ${JSON.stringify(want.title)}`;
      if (found.length === 0) reject("required-test", `required ${suite.name} test missing: ${label}`);
      else if (found.some((t) => t.outcome === "skipped")) reject("required-test", `required ${suite.name} test skipped: ${label}`);
      else if (found.some((t) => t.outcome === "failed")) reject("required-test", `required ${suite.name} test failed: ${label}`);
    }
  }
  return counts;
}

function checkCoverage(ctx, sealed, current) {
  const rel = "coverage/coverage-summary.json";
  const reject = (m) => ctx.reject("coverage", m);
  const summary = readJson(path.join(current, rel), rel, reject);
  if (!summary) return null;
  if (!sealed.has(rel)) return null; // the seal check already named it
  const total = summary.total ?? {};
  for (const [metric, bar] of Object.entries(COVERAGE_BAR)) {
    const pct = total[metric]?.pct;
    const name = metric === "statements" ? "statement" : "branch";
    if (typeof pct !== "number") reject(`${rel} has no total ${metric} percentage`);
    else if (pct < bar) reject(`${name} coverage ${pct}% is below ${bar}%`);
  }
  return total;
}

function checkGateDb(ctx, declared, current) {
  const log = path.join(current, "gate-db.log");
  const isDeclared = declared.some((check) => (check.argv ?? []).includes("test:db"));
  if (!fs.existsSync(log)) {
    if (isDeclared) ctx.reject("gate-db", "gate-db.log is missing: no record that the gate database was torn down");
    return;
  }
  const lines = fs.readFileSync(log, "utf8").split(/\r?\n/).map((line) => line.trim());
  if (!lines.includes(GATE_DB_TEARDOWN_MARKER)) {
    ctx.reject("gate-db", `gate-db.log has no line ${GATE_DB_TEARDOWN_MARKER}: the gate database run did not complete its teardown`);
  }
}

function checkProduction(ctx, dir, requiredCases) {
  const reject = (m) => ctx.reject("production", m);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    reject(`production evidence directory ${dir} is missing`);
    return 0;
  }
  const deployment = readJson(path.join(dir, "deployment.json"), "deployment.json", reject);
  const createdAt = Date.parse(deployment?.createdAt);
  if (deployment) {
    for (const field of ["deploymentId", "deploymentUrl", "commit"]) {
      if (typeof deployment[field] !== "string" || !deployment[field]) reject(`deployment.json has no ${field}`);
    }
    if (!Number.isFinite(createdAt)) reject(`deployment.json createdAt ${deployment.createdAt} is not a time`);
    if (deployment.commit && deployment.commit !== ctx.candidate.commit) {
      reject(`deployment.json commit ${deployment.commit} differs from the candidate ${ctx.candidate.commit}`);
    }
  }
  const run = readJson(path.join(dir, "run.json"), "run.json", reject);
  if (run && (typeof run.runId !== "string" || !run.runId)) reject("run.json has no runId");
  const kinds = new Map(requiredCases.map((c) => [c.id, c.kind]));
  const seen = new Map();
  const files = fs.readdirSync(dir).filter((name) => name.endsWith(".json") && name !== "deployment.json" && name !== "run.json").sort();
  for (const name of files) {
    const report = readJson(path.join(dir, name), name, reject);
    if (!report) continue;
    if (typeof report.case !== "string" || !report.case) {
      reject(`${name} names no case`);
      continue;
    }
    const passed = report.status === "passed";
    seen.set(report.case, (seen.get(report.case) ?? true) && passed);
    if (!passed) reject(`production case ${report.case} has status ${report.status}`);
    if (!kinds.has(report.case)) ctx.notes.push(`production case ${report.case} (${name}) is not in required-production-cases.json`);
    if (kinds.get(report.case) === "partner") {
      if (typeof report.exitCode !== "number") reject(`partner check ${report.case} recorded no exit code`);
      else if (report.exitCode !== 0) reject(`partner check ${report.case} exited ${report.exitCode}`);
    }
    if (kinds.get(report.case) === "binding") {
      for (const field of ["deploymentCommit", "aliasCommit"]) {
        if (report[field] !== ctx.candidate.commit) reject(`binding check ${report.case} ${field} ${report[field]} differs from the candidate ${ctx.candidate.commit}`);
      }
    }
    if (typeof run?.runId === "string" && run.runId && report.runId !== run.runId) {
      reject(`${name} run id ${report.runId} differs from run.json ${run.runId}`);
    }
    if (!deployment) continue;
    if (report.deploymentId !== deployment.deploymentId) {
      reject(`${name} deployment id ${report.deploymentId} differs from ${deployment.deploymentId}`);
    }
    if (report.deploymentUrl !== deployment.deploymentUrl) {
      reject(`${name} deployment URL ${report.deploymentUrl} differs from ${deployment.deploymentUrl}`);
    }
    if (report.commit !== ctx.candidate.commit) {
      reject(`${name} commit ${report.commit} differs from the candidate ${ctx.candidate.commit}`);
    }
    const recordedAt = Date.parse(report.recordedAt);
    if (!Number.isFinite(recordedAt)) reject(`${name} recordedAt ${report.recordedAt} is not a time`);
    else if (Number.isFinite(createdAt) && recordedAt < createdAt) {
      reject(`${name} was recorded at ${report.recordedAt}, before the deployment was created at ${deployment.createdAt}`);
    }
  }
  let passedCases = 0;
  for (const { id } of requiredCases) {
    if (!seen.has(id)) reject(`required production case ${id} is missing`);
    else if (seen.get(id)) passedCases += 1;
  }
  return passedCases;
}

function readList(root, file, key, reject) {
  const value = readJson(path.join(root, "tools", "release", file), `tools/release/${file}`, (m) => reject("input", m));
  const list = value?.[key];
  if (value && !Array.isArray(list)) reject("input", `tools/release/${file} has no ${key} list`);
  return Array.isArray(list) ? list : [];
}

export function analyze({ root, candidate, production, accept, reason }) {
  const reasons = [];
  const ctx = {
    root,
    candidate,
    exceptions: [],
    notes: [],
    reject: (category, message) => reasons.push({ category, message }),
  };
  const current = path.join(root, CURRENT);
  const policy = readJson(path.join(root, ".rpi", "policy.json"), ".rpi/policy.json", (m) => ctx.reject("input", m));
  const verification = readJson(path.join(root, VERIFICATION), VERIFICATION, (m) => ctx.reject("binding", m));
  const attempt = readJson(path.join(current, "attempt.json"), `${CURRENT}/attempt.json`, (m) => ctx.reject("binding", m));
  const requiredTests = readList(root, "required-tests.json", "tests", ctx.reject);

  checkBinding(ctx, verification, attempt);
  const sealed = checkSeal(ctx, attempt, current);
  const declared = checkRequiredChecks(ctx, policy, verification, accept, reason);
  const counts = checkSuites(ctx, declared, sealed, current, requiredTests);
  const coverage = checkCoverage(ctx, sealed, current);
  checkGateDb(ctx, declared, current);

  const productionCases = production ? checkProduction(ctx, production, readList(root, "required-production-cases.json", "cases", ctx.reject)) : null;
  return { reasons, exceptions: ctx.exceptions, notes: ctx.notes, counts, coverage, requiredTests, productionCases };
}

function print(options, candidate, result) {
  const out = [];
  out.push(`analyze-evidence: candidate ${candidate.commit} (tree ${candidate.tree})`);
  out.push(`mode: ${options.production ? `production (${options.production})` : "local"}`);
  if (result.exceptions.length > 0) {
    out.push("");
    out.push("!".repeat(72));
    for (const exception of result.exceptions) out.push(`ACCEPTED EXCEPTION: ${exception}`);
    out.push("These failures are accepted by the releaser, not passed. Present them with the evidence.");
    out.push("!".repeat(72));
  }
  for (const note of result.notes) out.push(`note: ${note}`);
  out.push("");
  if (result.reasons.length > 0) {
    out.push(`REJECTED: ${result.reasons.length} reason${result.reasons.length === 1 ? "" : "s"}`);
    for (const { category, message } of result.reasons) out.push(`  - [${category}] ${message}`);
  } else {
    out.push("ACCEPTED");
    out.push(`  passing tests: ${Object.entries(result.counts).map(([suite, n]) => `${suite} ${n}`).join(", ")}`);
    out.push(`  ${result.requiredTests.length} required tests passed`);
    if (result.coverage) {
      out.push(`  coverage: statements ${result.coverage.statements?.pct}%, branches ${result.coverage.branches?.pct}%`);
    }
    if (result.productionCases !== null) out.push(`  ${result.productionCases} required production cases passed`);
  }
  console.log(out.join("\n"));
}

function main() {
  let options;
  let candidate;
  try {
    options = parseArgs(process.argv.slice(2));
    candidate = resolveCandidate(options.root, options.candidate);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(`analyze-evidence: ${error.message}`);
    return 2;
  }
  const result = analyze({ ...options, candidate });
  print(options, candidate, result);
  return result.reasons.length === 0 ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
