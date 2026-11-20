import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("../../tools/release/analyze-evidence.mjs", import.meta.url));

// Git variables from a surrounding hook or worktree must not redirect the temporary repository.
const cleanEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
) as NodeJS.ProcessEnv;

// Fixtures edit arbitrary report JSON in place; a typed model of every report would add nothing here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

let root: string;
let candidate: string;
let tree: string;

const current = () => path.join(root, ".local/evidence/current");
const production = () => path.join(root, ".local/evidence/production/dpl_candidate");

function git(...args: string[]): string {
  const result = spawnSync("git", args, { cwd: root, env: cleanEnv, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function write(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
}

function read(file: string): Json {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function edit(file: string, change: (value: Json) => void) {
  const value = read(file);
  change(value);
  write(file, value);
}

function analyze(...args: string[]) {
  const result = spawnSync(process.execPath, [script, ...args, "--root", root], { env: cleanEnv, encoding: "utf8" });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

const policyChecks = [
  { name: "whitespace", argv: ["git", "diff", "--check"] },
  { name: "rpi-installation", argv: ["python3", ".rpi/scripts/rpi-distribution.py", "check"] },
  { name: "evidence-begin", argv: ["pnpm", "evidence:begin"] },
  { name: "unit-tests", argv: ["pnpm", "test"] },
  { name: "coverage", argv: ["pnpm", "test:coverage"] },
  { name: "perf", argv: ["pnpm", "test:perf"] },
  { name: "e2e", argv: ["pnpm", "test:e2e"] },
  { name: "evidence-seal", argv: ["pnpm", "evidence:seal"] },
];
const dbCheck = { name: "db-tests", argv: ["pnpm", "test:db"] };

function vitestReport(file: string, tests: Array<[string, string]>) {
  return {
    numTotalTests: tests.length,
    numPassedTests: tests.filter(([, status]) => status === "passed").length,
    numFailedTests: tests.filter(([, status]) => status === "failed").length,
    success: true,
    testResults: [
      {
        name: path.join(root, file),
        status: "passed",
        assertionResults: tests.map(([fullName, status]) => ({ fullName, title: fullName, status, ancestorTitles: [] })),
      },
    ],
  };
}

function playwrightReport(specs: Array<[string[], string, string]>) {
  return {
    stats: { expected: specs.filter(([, , status]) => status === "expected").length },
    suites: [
      {
        title: "spec6.spec.ts",
        file: "spec6.spec.ts",
        specs: [],
        suites: [
          {
            title: "spec §6 locally",
            file: "spec6.spec.ts",
            specs: specs.map(([, title, status]) => ({
              title,
              file: "spec6.spec.ts",
              ok: status !== "unexpected",
              tests: [
                {
                  projectName: "chromium",
                  expectedStatus: status === "skipped" ? "skipped" : "passed",
                  status,
                  results: [{ status: status === "expected" ? "passed" : status === "skipped" ? "skipped" : "failed" }],
                },
              ],
            })),
          },
        ],
      },
    ],
  };
}

const unitReport = () =>
  vitestReport("tests/fetch/guard.test.ts", [
    ["resolvePublic refuses loopback in production", "passed"],
    ["resolvePublic refuses link-local", "passed"],
    ["an unrelated test", "passed"],
  ]);
const perfReport = () => vitestReport("tests/perf/analyze-load.test.ts", [["analyze load stays within budgets", "passed"]]);
const dbReport = () => vitestReport("tests/db/store.test.ts", [["Store contract: supabase puts once", "passed"]]);
const pwReport = () =>
  playwrightReport([
    [[], "a two-agent network runs in the browser", "expected"],
    [[], "a cycle is prevented", "expected"],
  ]);

const requiredTests = {
  tests: [
    { rule: "fetch guard", suite: "unit", file: "tests/fetch/guard.test.ts", title: "resolvePublic refuses loopback in production" },
    { rule: "fetch guard", suite: "unit", file: "tests/fetch/guard.test.ts", title: "resolvePublic refuses link-local" },
    { rule: "spec 6", suite: "playwright", file: "spec6.spec.ts", title: "spec §6 locally a two-agent network runs in the browser" },
    { rule: "cycle prevention", suite: "playwright", file: "spec6.spec.ts", title: "spec §6 locally a cycle is prevented" },
  ],
};

const requiredCases = {
  cases: [
    { id: "partner-harbor-tours", kind: "partner" },
    { id: "health-ok", kind: "probe" },
    { id: "alias-binding", kind: "binding", aliases: ["retrofit.thecreativetoken.com", "demo-harbor.thecreativetoken.com"] },
  ],
};
/** Vercel's identity of every host, before (09:02) and after (09:10) the cases recorded at 09:05. */
const IDENTITY_HOSTS = { "retrofit-abc123.vercel.app": "dpl_candidate", "retrofit.thecreativetoken.com": "dpl_candidate", "demo-harbor.thecreativetoken.com": "dpl_candidate" };
const IDENTITY = {
  source: "vercel inspect",
  before: { checkedAt: "2026-11-16T09:02:00.000Z", deployments: IDENTITY_HOSTS },
  after: { checkedAt: "2026-11-16T09:10:00.000Z", deployments: IDENTITY_HOSTS },
};
const RUN_ID = "run_0123456789abcdef";

function seal() {
  const attemptFile = path.join(current(), "attempt.json");
  const list = (dir: string, rel = ""): string[] =>
    fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).flatMap((entry) => {
      const name = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) return list(dir, name);
      return name === "attempt.json" ? [] : [name];
    });
  edit(attemptFile, (attempt) => {
    attempt.seal = {
      sealedAt: "2026-11-15T10:16:07.000Z",
      reports: list(current())
        .sort()
        .map((rel) => {
          const bytes = fs.readFileSync(path.join(current(), rel));
          return { path: rel, sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length, mtimeMs: 1 };
        }),
    };
  });
}

/** Rewrites one sealed report and seals again, as a new gate run would. */
function reseal(rel: string, value: unknown) {
  write(path.join(current(), rel), value);
  seal();
}

function setPolicy(checks: Json[]) {
  write(path.join(root, ".rpi/policy.json"), { schema_version: 1, verification_checks: checks });
  edit(path.join(root, ".rpi/local/verification.json"), (verification) => {
    verification.checks = checks.map((check) => ({ ...check, exit_code: 0, duration_seconds: 0.1 }));
  });
}

function setCheckExit(name: string, code: number) {
  edit(path.join(root, ".rpi/local/verification.json"), (verification) => {
    verification.checks.find((check: Json) => check.name === name).exit_code = code;
  });
}

function caseReport(id: string, extra: Json = {}) {
  return {
    case: id,
    status: "passed",
    deploymentId: "dpl_candidate",
    deploymentUrl: "https://retrofit-abc123.vercel.app",
    commit: candidate,
    recordedAt: "2026-11-16T09:05:00.000Z",
    runId: RUN_ID,
    ...extra,
  };
}

function writeProduction() {
  write(path.join(production(), "deployment.json"), {
    deploymentId: "dpl_candidate",
    deploymentUrl: "https://retrofit-abc123.vercel.app",
    createdAt: "2026-11-16T09:00:00.000Z",
    commit: candidate,
  });
  write(path.join(production(), "partner-harbor-tours.json"), caseReport("partner-harbor-tours", { exitCode: 0 }));
  write(path.join(production(), "health-ok.json"), caseReport("health-ok"));
  write(path.join(production(), "alias-binding.json"), caseReport("alias-binding", { deploymentCommit: candidate, aliasCommit: candidate, identity: IDENTITY }));
  write(path.join(production(), "run.json"), { runId: RUN_ID, startedAt: "2026-11-16T09:01:00.000Z", deploymentId: "dpl_candidate" });
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "retrofit-analyze-")));
  git("init", "-q");
  git("config", "user.email", "test@example.test");
  git("config", "user.name", "Analyzer Test");
  git("config", "commit.gpgsign", "false");
  write(path.join(root, ".gitignore"), ".local/\n.rpi/local/\n");
  write(path.join(root, "tracked.txt"), "one\n");
  write(path.join(root, "tools/release/required-tests.json"), requiredTests);
  write(path.join(root, "tools/release/required-production-cases.json"), requiredCases);
  write(path.join(root, ".rpi/policy.json"), { schema_version: 1, verification_checks: policyChecks });
  git("add", ".");
  git("commit", "-q", "-m", "candidate");
  candidate = git("rev-parse", "HEAD");
  tree = git("rev-parse", "HEAD^{tree}");

  write(path.join(root, ".rpi/local/verification.json"), {
    schema_version: 1,
    suite: "ci-equivalent",
    attempt_id: "029df4c680c84e0aaa1843231d9b5fe7",
    status: "complete",
    passed: true,
    started_at: "2026-11-15T10:14:47.974828+00:00",
    recorded_at: "2026-11-15T10:16:08.000000+00:00",
    identity: { sha256: "a".repeat(64), file_count: 3, commit: candidate },
    identity_after: { sha256: "a".repeat(64), file_count: 3, commit: candidate },
    identity_unchanged: true,
    environment_unchanged: true,
    checks: policyChecks.map((check) => ({ ...check, exit_code: 0, duration_seconds: 0.1 })),
  });
  write(path.join(current(), "attempt.json"), {
    nonce: "e8180faa8551688a2d01da1b5e76c9cf",
    commit: candidate,
    tree,
    startedAt: "2026-11-15T10:14:48.367Z",
    startedAtMs: Date.parse("2026-11-15T10:14:48.367Z"),
  });
  write(path.join(current(), "vitest-unit.json"), unitReport());
  write(path.join(current(), "vitest-perf.json"), perfReport());
  write(path.join(current(), "playwright.json"), pwReport());
  write(path.join(current(), "coverage/coverage-summary.json"), {
    total: { statements: { pct: 93.05 }, branches: { pct: 87.75 }, lines: { pct: 95 }, functions: { pct: 93 } },
  });
  seal();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("analyze-evidence usage", () => {
  it("exits 2 without a candidate", () => {
    const result = analyze();
    expect(result.status).toBe(2);
    expect(result.out).toContain("usage");
  });

  it("exits 2 for a candidate Git cannot resolve", () => {
    const result = analyze("0".repeat(40));
    expect(result.status).toBe(2);
    expect(result.out).toContain("cannot resolve candidate");
  });

  it("exits 2 for an unknown argument", () => {
    const result = analyze(candidate, "--fast");
    expect(result.status).toBe(2);
    expect(result.out).toContain("unknown argument: --fast");
  });
});

describe("analyze-evidence local mode", () => {
  it("accepts a complete set sealed for the candidate", () => {
    const result = analyze(candidate);
    expect(result.status, result.out).toBe(0);
    expect(result.out).toContain("ACCEPTED");
    expect(result.out).toContain("4 required tests passed");
  });

  it("accepts a short candidate commit that resolves to the sealed commit", () => {
    expect(analyze(candidate.slice(0, 12)).status).toBe(0);
  });

  it("rejects an attempt bound to another commit than the candidate", () => {
    const old = candidate;
    write(path.join(root, "tracked.txt"), "two\n");
    git("commit", "-q", "-am", "next");
    const next = git("rev-parse", "HEAD");
    edit(path.join(root, ".rpi/local/verification.json"), (v) => {
      v.identity.commit = next;
    });
    edit(path.join(current(), "attempt.json"), (a) => {
      a.tree = git("rev-parse", "HEAD^{tree}");
    });
    const result = analyze(next);
    expect(result.status).toBe(1);
    expect(result.out).toContain(`attempt.json commit ${old} differs from the candidate ${next}`);
    expect(result.out).not.toContain("attempt.json tree");
  });

  it("rejects an attempt bound to another tree than the candidate's", () => {
    edit(path.join(current(), "attempt.json"), (a) => {
      a.tree = "b".repeat(40);
    });
    const result = analyze(candidate);
    expect(result.status).toBe(1);
    expect(result.out).toContain(`attempt.json tree ${"b".repeat(40)} differs from the candidate tree ${tree}`);
  });

  it("rejects an attempt whose commit differs from the verification identity", () => {
    edit(path.join(root, ".rpi/local/verification.json"), (v) => {
      v.identity.commit = "c".repeat(40);
    });
    const result = analyze(candidate);
    expect(result.status).toBe(1);
    expect(result.out).toContain(`verification.json identity commit ${"c".repeat(40)} differs from the candidate`);
    expect(result.out).toContain("differs from verification.json identity commit");
  });

  it("rejects an attempt that started before the verification attempt", () => {
    edit(path.join(current(), "attempt.json"), (a) => {
      a.startedAt = "2026-11-15T10:14:40.000Z";
    });
    const result = analyze(candidate);
    expect(result.status).toBe(1);
    expect(result.out).toContain("attempt.json started at 2026-11-15T10:14:40.000Z, before verification.json started_at");
  });

  it("rejects a verification receipt from a custom check selection", () => {
    edit(path.join(root, ".rpi/local/verification.json"), (v) => {
      v.suite = "custom";
    });
    const result = analyze(candidate);
    expect(result.status).toBe(1);
    expect(result.out).toContain('verification.json suite is "custom"');
  });

  it("rejects a verification run whose inputs changed during the run", () => {
    edit(path.join(root, ".rpi/local/verification.json"), (v) => {
      v.identity_unchanged = false;
    });
    const result = analyze(candidate);
    expect(result.status).toBe(1);
    expect(result.out).toContain("identity_unchanged is not true");
  });

  it("rejects a missing verification receipt", () => {
    fs.rmSync(path.join(root, ".rpi/local/verification.json"));
    const result = analyze(candidate);
    expect(result.status).toBe(1);
    expect(result.out).toContain(".rpi/local/verification.json is missing");
  });

  it("rejects an attempt that was never sealed", () => {
    edit(path.join(current(), "attempt.json"), (a) => {
      delete a.seal;
    });
    const result = analyze(candidate);
    expect(result.status).toBe(1);
    expect(result.out).toContain("attempt.json has no seal");
  });

  it("rejects a report that is not listed in the seal", () => {
    write(path.join(current(), "vitest-extra.json"), unitReport());
    const result = analyze(candidate);
    expect(result.status).toBe(1);
    expect(result.out).toContain("vitest-extra.json is not listed in the seal");
  });

  it("rejects a report whose hash differs from the seal", () => {
    edit(path.join(current(), "vitest-unit.json"), (r) => {
      r.numPassedTests = 99;
    });
    const result = analyze(candidate);
    expect(result.status).toBe(1);
    expect(result.out).toContain("vitest-unit.json sha256");
    expect(result.out).toContain("differs from the seal");
  });

  it("rejects a sealed report that is gone", () => {
    fs.rmSync(path.join(current(), "vitest-perf.json"));
    const result = analyze(candidate);
    expect(result.status).toBe(1);
    expect(result.out).toContain("sealed report vitest-perf.json is missing");
  });

  it("rejects a required check that is missing from the verification receipt", () => {
    edit(path.join(root, ".rpi/local/verification.json"), (v) => {
      v.checks = v.checks.filter((check: Json) => check.name !== "e2e");
    });
    const result = analyze(candidate);
    expect(result.status).toBe(1);
    expect(result.out).toContain("required check e2e is missing");
  });

  it("rejects a required check that ran a different command", () => {
    edit(path.join(root, ".rpi/local/verification.json"), (v) => {
      v.checks.find((check: Json) => check.name === "unit-tests").argv = ["true"];
    });
    const result = analyze(candidate);
    expect(result.status).toBe(1);
    expect(result.out).toContain("required check unit-tests ran");
  });

  it("rejects a required check with a non-zero exit", () => {
    setCheckExit("unit-tests", 1);
    const result = analyze(candidate);
    expect(result.status).toBe(1);
    expect(result.out).toContain("required check unit-tests exited 1");
  });

  it("rejects zero passing tests in the unit suite", () => {
    reseal("vitest-unit.json", vitestReport("tests/fetch/guard.test.ts", []));
    const result = analyze(candidate);
    expect(result.status).toBe(1);
    expect(result.out).toContain("suite unit has zero passing tests");
  });

  it("rejects zero passing tests in the perf suite", () => {
    reseal("vitest-perf.json", vitestReport("tests/perf/analyze-load.test.ts", [["a load test", "skipped"]]));
    const result = analyze(candidate);
    expect(result.status).toBe(1);
    expect(result.out).toContain("suite perf has zero passing tests");
  });

  it("rejects zero passing tests in the playwright suite", () => {
    reseal("playwright.json", playwrightReport([]));
    const result = analyze(candidate);
    expect(result.status).toBe(1);
    expect(result.out).toContain("suite playwright has zero passing tests");
  });

  it("rejects a failed test in any suite", () => {
    reseal(
      "vitest-perf.json",
      vitestReport("tests/perf/analyze-load.test.ts", [
        ["analyze load stays within budgets", "passed"],
        ["viewers stay within budgets", "failed"],
      ]),
    );
    const result = analyze(candidate);
    expect(result.status).toBe(1);
    expect(result.out).toContain("suite perf has 1 failed test");
  });

  it("rejects a missing suite report", () => {
    fs.rmSync(path.join(current(), "playwright.json"));
    seal();
    const result = analyze(candidate);
    expect(result.status).toBe(1);
    expect(result.out).toContain("suite playwright report playwright.json is missing");
    expect(result.out).toContain("2 required playwright tests cannot be checked");
  });

  it("rejects a skipped required vitest test", () => {
    reseal(
      "vitest-unit.json",
      vitestReport("tests/fetch/guard.test.ts", [
        ["resolvePublic refuses loopback in production", "passed"],
        ["resolvePublic refuses link-local", "skipped"],
      ]),
    );
    const result = analyze(candidate);
    expect(result.status).toBe(1);
    expect(result.out).toContain('required unit test skipped: tests/fetch/guard.test.ts "resolvePublic refuses link-local"');
  });

  it("rejects a missing required vitest test", () => {
    reseal("vitest-unit.json", vitestReport("tests/fetch/guard.test.ts", [["resolvePublic refuses loopback in production", "passed"]]));
    const result = analyze(candidate);
    expect(result.status).toBe(1);
    expect(result.out).toContain('required unit test missing: tests/fetch/guard.test.ts "resolvePublic refuses link-local"');
  });

  it("rejects a required test found only in another file", () => {
    reseal(
      "vitest-unit.json",
      vitestReport("tests/other/guard.test.ts", [
        ["resolvePublic refuses loopback in production", "passed"],
        ["resolvePublic refuses link-local", "passed"],
      ]),
    );
    const result = analyze(candidate);
    expect(result.status).toBe(1);
    expect(result.out).toContain('required unit test missing: tests/fetch/guard.test.ts "resolvePublic refuses loopback in production"');
  });

  it("rejects a skipped required playwright test", () => {
    reseal(
      "playwright.json",
      playwrightReport([
        [[], "a two-agent network runs in the browser", "expected"],
        [[], "a cycle is prevented", "skipped"],
      ]),
    );
    const result = analyze(candidate);
    expect(result.status).toBe(1);
    expect(result.out).toContain('required playwright test skipped: spec6.spec.ts "spec §6 locally a cycle is prevented"');
  });

  it("rejects statement coverage below 80", () => {
    reseal("coverage/coverage-summary.json", { total: { statements: { pct: 79.99 }, branches: { pct: 87 } } });
    const result = analyze(candidate);
    expect(result.status).toBe(1);
    expect(result.out).toContain("statement coverage 79.99% is below 80%");
  });

  it("rejects branch coverage below 70", () => {
    reseal("coverage/coverage-summary.json", { total: { statements: { pct: 93 }, branches: { pct: 69.5 } } });
    const result = analyze(candidate);
    expect(result.status).toBe(1);
    expect(result.out).toContain("branch coverage 69.5% is below 70%");
  });

  it("rejects a missing coverage summary", () => {
    fs.rmSync(path.join(current(), "coverage"), { recursive: true });
    seal();
    const result = analyze(candidate);
    expect(result.status).toBe(1);
    expect(result.out).toContain("coverage/coverage-summary.json is missing");
  });

  it("lists every reason when several items fail", () => {
    setCheckExit("e2e", 1);
    reseal("coverage/coverage-summary.json", { total: { statements: { pct: 50 }, branches: { pct: 50 } } });
    const result = analyze(candidate);
    expect(result.status).toBe(1);
    expect(result.out).toContain("REJECTED: 3 reasons");
    expect(result.out).toContain("required check e2e exited 1");
    expect(result.out).toContain("statement coverage 50% is below 80%");
    expect(result.out).toContain("branch coverage 50% is below 70%");
  });
});

describe("analyze-evidence gate database", () => {
  beforeEach(() => {
    setPolicy([...policyChecks.slice(0, 5), dbCheck, ...policyChecks.slice(5)]);
    write(path.join(current(), "vitest-db.json"), dbReport());
    write(path.join(current(), "gate-db.log"), "GATE-DB START retrofit-gate\nstopped\nGATE-DB TEARDOWN COMPLETE\n");
    seal();
  });

  it("accepts a db run whose log records a completed teardown", () => {
    const result = analyze(candidate);
    expect(result.status, result.out).toBe(0);
  });

  it("rejects zero passing tests in the db suite", () => {
    reseal("vitest-db.json", vitestReport("tests/db/store.test.ts", []));
    const result = analyze(candidate);
    expect(result.status).toBe(1);
    expect(result.out).toContain("suite db has zero passing tests");
  });

  it("rejects a db suite report that is missing when test:db is declared", () => {
    fs.rmSync(path.join(current(), "vitest-db.json"));
    seal();
    const result = analyze(candidate);
    expect(result.status).toBe(1);
    expect(result.out).toContain("suite db report vitest-db.json is missing");
  });

  it("rejects a gate database log without a completed teardown", () => {
    reseal("gate-db.log", "GATE-DB START retrofit-gate\ntests failed\n");
    const result = analyze(candidate);
    expect(result.status).toBe(1);
    expect(result.out).toContain("gate-db.log has no line GATE-DB TEARDOWN COMPLETE");
  });

  it("rejects a gate database run with no log", () => {
    fs.rmSync(path.join(current(), "gate-db.log"));
    seal();
    const result = analyze(candidate);
    expect(result.status).toBe(1);
    expect(result.out).toContain("gate-db.log is missing");
  });

  it("checks a gate database log that is present even when test:db is not declared", () => {
    setPolicy(policyChecks);
    reseal("gate-db.log", "GATE-DB START retrofit-gate\n");
    const result = analyze(candidate);
    expect(result.status).toBe(1);
    expect(result.out).toContain("gate-db.log has no line GATE-DB TEARDOWN COMPLETE");
  });
});

describe("analyze-evidence accepted check exceptions", () => {
  it("rejects a failed rpi-installation check without an exception", () => {
    setCheckExit("rpi-installation", 2);
    const result = analyze(candidate);
    expect(result.status).toBe(1);
    expect(result.out).toContain("required check rpi-installation exited 2");
  });

  it("accepts a failed rpi-installation check with an exception and prints it prominently", () => {
    setCheckExit("rpi-installation", 2);
    const result = analyze(candidate, "--accept-failed-check", "rpi-installation", "--reason", "cc-rpi source drift");
    expect(result.status, result.out).toBe(0);
    expect(result.out).toContain("ACCEPTED EXCEPTION: required check rpi-installation exited 2; reason: cc-rpi source drift");
  });

  it("still rejects other failures when an exception is given", () => {
    setCheckExit("rpi-installation", 2);
    setCheckExit("e2e", 1);
    const result = analyze(candidate, "--accept-failed-check", "rpi-installation", "--reason", "drift");
    expect(result.status).toBe(1);
    expect(result.out).toContain("required check e2e exited 1");
    expect(result.out).toContain("ACCEPTED EXCEPTION: required check rpi-installation exited 2");
  });

  it("does not excuse a missing check", () => {
    edit(path.join(root, ".rpi/local/verification.json"), (v) => {
      v.checks = v.checks.filter((check: Json) => check.name !== "rpi-installation");
    });
    const result = analyze(candidate, "--accept-failed-check", "rpi-installation", "--reason", "drift");
    expect(result.status).toBe(1);
    expect(result.out).toContain("required check rpi-installation is missing");
  });

  it("notes an exception that the evidence did not need", () => {
    const result = analyze(candidate, "--accept-failed-check", "rpi-installation", "--reason", "drift");
    expect(result.status).toBe(0);
    expect(result.out).toContain("exception for rpi-installation was not used: the check passed");
  });

  it("refuses an exception for a check outside the environment allowlist", () => {
    setCheckExit("e2e", 1);
    const result = analyze(candidate, "--accept-failed-check", "e2e", "--reason", "flaky");
    expect(result.status).toBe(2);
    expect(result.out).toContain("e2e is not in the environment-failure allowlist");
  });

  it("refuses an exception without a reason", () => {
    const result = analyze(candidate, "--accept-failed-check", "rpi-installation");
    expect(result.status).toBe(2);
    expect(result.out).toContain("--reason");
  });

  it("refuses a blank reason", () => {
    const result = analyze(candidate, "--accept-failed-check", "rpi-installation", "--reason", "  ");
    expect(result.status).toBe(2);
    expect(result.out).toContain("--reason");
  });
});

describe("analyze-evidence production mode", () => {
  beforeEach(() => {
    writeProduction();
  });

  const run = () => analyze(candidate, "--production", production());

  it("accepts production evidence bound to the candidate deployment", () => {
    const result = run();
    expect(result.status, result.out).toBe(0);
    expect(result.out).toContain("3 required production cases passed");
  });

  it("rejects a report from another run of the evidence script", () => {
    write(path.join(production(), "health-ok.json"), caseReport("health-ok", { runId: "run_older" }));
    const result = run();
    expect(result.status).toBe(1);
    expect(result.out).toContain(`health-ok.json run id run_older differs from run.json ${RUN_ID}`);
  });

  it("rejects production evidence without run.json", () => {
    fs.rmSync(path.join(production(), "run.json"));
    const result = run();
    expect(result.status).toBe(1);
    expect(result.out).toContain("run.json is missing");
  });

  it("rejects an alias that serves another commit than the deployment", () => {
    write(path.join(production(), "alias-binding.json"), caseReport("alias-binding", { deploymentCommit: candidate, aliasCommit: "d".repeat(40), identity: IDENTITY }));
    const result = run();
    expect(result.status).toBe(1);
    expect(result.out).toContain(`binding check alias-binding aliasCommit ${"d".repeat(40)} differs from the candidate`);
  });

  // Fails if a binding case without declared aliases checks only the deployment URL (V10: the alias and peer host).
  it("rejects a required binding case that lists no aliases", () => {
    write(path.join(root, "tools/release/required-production-cases.json"), { cases: requiredCases.cases.map((c) => (c.kind === "binding" ? { id: c.id, kind: c.kind } : c)) });
    git("add", ".");
    git("commit", "-q", "-m", "no aliases");
    const result = analyze(git("rev-parse", "HEAD"), "--production", production());
    expect(result.out).toContain("required-production-cases.json binding case alias-binding lists no aliases");
  });

  it("rejects a binding check that recorded no deployment commit", () => {
    write(path.join(production(), "alias-binding.json"), caseReport("alias-binding", { aliasCommit: candidate, identity: IDENTITY }));
    const result = run();
    expect(result.status).toBe(1);
    expect(result.out).toContain("binding check alias-binding deploymentCommit undefined differs from the candidate");
  });

  it("still applies every local rejection", () => {
    setCheckExit("e2e", 1);
    const result = run();
    expect(result.status).toBe(1);
    expect(result.out).toContain("required check e2e exited 1");
  });

  it("rejects a report bound to another deployment id", () => {
    write(path.join(production(), "health-ok.json"), caseReport("health-ok", { deploymentId: "dpl_other" }));
    const result = run();
    expect(result.status).toBe(1);
    expect(result.out).toContain("health-ok.json deployment id dpl_other differs from dpl_candidate");
  });

  it("rejects a report bound to another deployment URL", () => {
    write(path.join(production(), "health-ok.json"), caseReport("health-ok", { deploymentUrl: "https://retrofit-old.vercel.app" }));
    const result = run();
    expect(result.status).toBe(1);
    expect(result.out).toContain("health-ok.json deployment URL https://retrofit-old.vercel.app differs");
  });

  it("rejects a report whose /api/version commit differs from the candidate", () => {
    write(path.join(production(), "health-ok.json"), caseReport("health-ok", { commit: "d".repeat(40) }));
    const result = run();
    expect(result.status).toBe(1);
    expect(result.out).toContain(`health-ok.json commit ${"d".repeat(40)} differs from the candidate`);
  });

  it("rejects a deployment record for another commit", () => {
    edit(path.join(production(), "deployment.json"), (d) => {
      d.commit = "e".repeat(40);
    });
    const result = run();
    expect(result.status).toBe(1);
    expect(result.out).toContain(`deployment.json commit ${"e".repeat(40)} differs from the candidate`);
  });

  it("rejects a report recorded before the deployment was created", () => {
    write(path.join(production(), "health-ok.json"), caseReport("health-ok", { recordedAt: "2026-11-16T08:59:59.000Z" }));
    const result = run();
    expect(result.status).toBe(1);
    expect(result.out).toContain("health-ok.json was recorded at 2026-11-16T08:59:59.000Z, before the deployment was created");
  });

  it("rejects a missing required production case", () => {
    fs.rmSync(path.join(production(), "health-ok.json"));
    const result = run();
    expect(result.status).toBe(1);
    expect(result.out).toContain("required production case health-ok is missing");
  });

  it("rejects a failed production case", () => {
    write(path.join(production(), "health-ok.json"), caseReport("health-ok", { status: "failed" }));
    const result = run();
    expect(result.status).toBe(1);
    expect(result.out).toContain("production case health-ok has status failed");
  });

  it("rejects a skipped production case", () => {
    write(path.join(production(), "health-ok.json"), caseReport("health-ok", { status: "skipped" }));
    const result = run();
    expect(result.status).toBe(1);
    expect(result.out).toContain("production case health-ok has status skipped");
  });

  it("rejects a partner check with a non-zero exit", () => {
    write(path.join(production(), "partner-harbor-tours.json"), caseReport("partner-harbor-tours", { exitCode: 1 }));
    const result = run();
    expect(result.status).toBe(1);
    expect(result.out).toContain("partner check partner-harbor-tours exited 1");
  });

  it("rejects a partner check with no recorded exit code", () => {
    write(path.join(production(), "partner-harbor-tours.json"), caseReport("partner-harbor-tours"));
    const result = run();
    expect(result.status).toBe(1);
    expect(result.out).toContain("partner check partner-harbor-tours recorded no exit code");
  });

  it("rejects a missing deployment record", () => {
    fs.rmSync(path.join(production(), "deployment.json"));
    const result = run();
    expect(result.status).toBe(1);
    expect(result.out).toContain("deployment.json is missing");
  });

  it("rejects a missing production evidence directory", () => {
    fs.rmSync(production(), { recursive: true });
    const result = run();
    expect(result.status).toBe(1);
    expect(result.out).toContain("production evidence directory");
  });
});
