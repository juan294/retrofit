import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The boundary: every outward command goes through node:child_process and every HTTP call through
// the global fetch. Both are stubbed here; a call that is not expected fails the test.
const { spawnSync, execFileSync } = vi.hoisted(() => ({ spawnSync: vi.fn(), execFileSync: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => ({ ...(await importOriginal<typeof import("node:child_process")>()), spawnSync, execFileSync }));

const { main } = await import("../../tools/release/production-evidence.mjs");
const { analyze } = await import("../../tools/release/analyze-evidence.mjs");
const { writeCase, resetCommitCache } = await import("../../e2e-prod/support/report");
const { caseReport, writeCaseFile } = await import("../../e2e-prod/support/case-report.mjs");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const required = JSON.parse(fs.readFileSync(path.join(ROOT, "tools/release/required-production-cases.json"), "utf8")).cases as { id: string; kind: string }[];
const requiredIds = required.map((c) => c.id).sort();

const COMMIT = "a".repeat(40);
const DEPLOYMENT_ID = "dpl_candidate123";
const DEPLOYMENT_URL = "https://retrofit-abc123-thecreativetoken.vercel.app";
const PROD = "https://retrofit.thecreativetoken.com";

let tmp: string;
let fetchStub: ReturnType<typeof vi.fn>;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "prod-evidence-"));
  spawnSync.mockReset();
  execFileSync.mockReset();
  spawnSync.mockImplementation(() => {
    throw new Error("unexpected command");
  });
  execFileSync.mockImplementation(() => {
    throw new Error("unexpected command");
  });
  fetchStub = vi.fn(async () => {
    throw new Error("unexpected fetch");
  });
  vi.stubGlobal("fetch", fetchStub);
  resetCommitCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function capture() {
  const lines: string[] = [];
  return { lines, io: { stdout: (s: string) => lines.push(s), stderr: (s: string) => lines.push(s) } };
}

/** Production-mode reasons from the analyzer for evidence in `dir`, with tools/release copied into a scratch root. */
function productionVerdict(dir: string) {
  const root = path.join(tmp, "root");
  fs.mkdirSync(path.join(root, "tools/release"), { recursive: true });
  fs.copyFileSync(path.join(ROOT, "tools/release/required-production-cases.json"), path.join(root, "tools/release/required-production-cases.json"));
  const result = analyze({ root, candidate: { commit: COMMIT, tree: "b".repeat(40) }, production: dir, accept: [], reason: null });
  return { reasons: result.reasons.filter((r: { category: string }) => r.category === "production"), passed: result.productionCases };
}

describe("production-evidence.mjs --dry-run", () => {
  it("prints every command and URL, covers every required case, and contacts nothing", async () => {
    const { lines, io } = capture();
    const code = await main([DEPLOYMENT_ID, DEPLOYMENT_URL, COMMIT, "--dry-run", "--evidence-dir", tmp], io);
    const out = lines.join("\n");
    expect(code).toBe(0);
    expect(spawnSync).not.toHaveBeenCalled();
    expect(execFileSync).not.toHaveBeenCalled();
    expect(fetchStub).not.toHaveBeenCalled();
    expect(fs.readdirSync(tmp)).toEqual([]);

    const produced = [...out.matchAll(/^step \d+ [a-z-]+ -> (.+)$/gm)].flatMap((m) => m[1]!.split(", ")).filter((id) => id !== "deployment.json");
    expect([...new Set(produced)].sort()).toEqual(requiredIds);
    expect(out).toContain(`covers ${requiredIds.length} of ${requiredIds.length} required production cases`);

    // Every outward call is named.
    expect(out).toContain(`$ vercel inspect ${DEPLOYMENT_URL} --format json --scope thecreativetoken`);
    expect(out).toContain(`GET ${PROD}/api/version`);
    expect(out).toContain(`GET ${DEPLOYMENT_URL}/api/version`);
    expect(out).toContain(`GET ${PROD}/api/health`);
    expect(out).toMatch(/run\.json with a new run id/);
    for (const c of required.filter((x) => x.kind === "partner")) expect(out).toContain(`tools/agentic-web/scripts/check_partner.mjs ${(c as { target?: string }).target}`);
    expect(out).toMatch(/POST https:\/\/retrofit\.thecreativetoken\.com\/api\/analyze x5 \(concurrent\)/);
    expect(out).toContain("$ vercel list retrofit --environment preview --scope thecreativetoken");
    expect(out).toContain("pnpm exec playwright test --config e2e-prod/playwright.config.ts");
    // The judge code is passed through, never printed.
    expect(out).toContain("JUDGE_CODE=<from the environment, not printed>");
  });

  it("refuses a short commit, a bad deployment id and a non-https deployment URL", async () => {
    for (const argv of [
      [DEPLOYMENT_ID, DEPLOYMENT_URL, "abc1234", "--dry-run"],
      ["candidate", DEPLOYMENT_URL, COMMIT, "--dry-run"],
      [DEPLOYMENT_ID, "http://retrofit.example", COMMIT, "--dry-run"],
    ]) {
      const { io } = capture();
      expect(await main(argv, io)).toBe(2);
    }
    expect(fetchStub).not.toHaveBeenCalled();
  });
});

describe("writeCase report shape", () => {
  const env = { RETROFIT_DEPLOYMENT_ID: DEPLOYMENT_ID, RETROFIT_DEPLOYMENT_URL: DEPLOYMENT_URL, RETROFIT_PROD_URL: PROD, RETROFIT_RUN_ID: "run_test0001" };

  it("binds the report to the deployment and the commit from /api/version; extra data cannot rebind it", async () => {
    fetchStub.mockImplementation(async (url: string) => {
      expect(url).toBe(`${PROD}/api/version`);
      return new Response(JSON.stringify({ commit: COMMIT }), { status: 200 });
    });
    const file = await writeCase("spec6-score-site", "passed", { scoreCalls: 1, commit: "f".repeat(40), deploymentId: "dpl_other" }, { env: { ...env, RETROFIT_EVIDENCE_DIR: tmp } });
    expect(file).toBe(path.join(tmp, DEPLOYMENT_ID, "spec6-score-site.json"));
    const report = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(report).toMatchObject({ case: "spec6-score-site", status: "passed", deploymentId: DEPLOYMENT_ID, deploymentUrl: DEPLOYMENT_URL, commit: COMMIT, runId: "run_test0001", scoreCalls: 1 });
    expect(Number.isFinite(Date.parse(report.recordedAt))).toBe(true);
  });

  it("refuses to write without the deployment id and URL, or without the run id", async () => {
    await expect(writeCase("health-ok", "passed", {}, { env: { RETROFIT_EVIDENCE_DIR: tmp } })).rejects.toThrow(/RETROFIT_DEPLOYMENT_ID/);
    await expect(writeCase("health-ok", "passed", {}, { env: { ...env, RETROFIT_RUN_ID: "", RETROFIT_EVIDENCE_DIR: tmp } })).rejects.toThrow(/RETROFIT_RUN_ID/);
  });

  it("records an unreadable /api/version as unavailable, which the analyzer rejects", async () => {
    fetchStub.mockImplementation(async () => new Response("down", { status: 503 }));
    const file = await writeCase("health-ok", "passed", {}, { env: { ...env, RETROFIT_EVIDENCE_DIR: tmp } });
    expect(JSON.parse(fs.readFileSync(file, "utf8")).commit).toBe("unavailable (status 503)");
  });

  it("the analyzer's production mode accepts a full set written by writeCase", async () => {
    fetchStub.mockImplementation(async () => new Response(JSON.stringify({ commit: COMMIT }), { status: 200 }));
    const dir = path.join(tmp, DEPLOYMENT_ID);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "deployment.json"), JSON.stringify({ deploymentId: DEPLOYMENT_ID, deploymentUrl: DEPLOYMENT_URL, createdAt: new Date(Date.now() - 60_000).toISOString(), commit: COMMIT }));
    fs.writeFileSync(path.join(dir, "run.json"), JSON.stringify({ runId: "run_test0001", deploymentId: DEPLOYMENT_ID }));
    const kindExtra = (kind: string) => (kind === "partner" ? { exitCode: 0 } : kind === "binding" ? { deploymentCommit: COMMIT, aliasCommit: COMMIT } : {});
    for (const c of required) await writeCase(c.id, "passed", kindExtra(c.kind), { env: { ...env, RETROFIT_EVIDENCE_DIR: tmp } });
    const verdict = productionVerdict(dir);
    expect(verdict.reasons).toEqual([]);
    expect(verdict.passed).toBe(required.length);

    // It rejects a report from another run.
    await writeCase("health-ok", "passed", {}, { env: { ...env, RETROFIT_RUN_ID: "run_other", RETROFIT_EVIDENCE_DIR: tmp } });
    expect(productionVerdict(dir).reasons.map((r: { message: string }) => r.message)).toContain("health-ok.json run id run_other differs from run.json run_test0001");
    await writeCase("health-ok", "passed", {}, { env: { ...env, RETROFIT_EVIDENCE_DIR: tmp } });

    // And it rejects the same set when one case failed.
    await writeCase("spec6-cycle-prevention", "failed", {}, { env: { ...env, RETROFIT_EVIDENCE_DIR: tmp } });
    expect(productionVerdict(dir).reasons.map((r: { message: string }) => r.message)).toContain("production case spec6-cycle-prevention has status failed");
  });
});

describe("production-evidence.mjs run (stubbed boundary)", () => {
  it("writes deployment.json and every script case, runs Playwright with the binding environment, and the analyzer accepts the set", async () => {
    const createdAt = Date.now() - 60_000;
    const commands: string[] = [];
    spawnSync.mockImplementation((cmd: string, args: string[], options: { env?: Record<string, string> }) => {
      commands.push([path.basename(cmd), ...args].join(" "));
      if (cmd === "vercel" && args[0] === "inspect") return { status: 0, stdout: JSON.stringify({ id: DEPLOYMENT_ID, url: DEPLOYMENT_URL.slice(8), createdAt, target: "production" }), stderr: "" };
      if (cmd === "vercel" && args[0] === "list") return { status: 0, stdout: "", stderr: "> No deployments found." };
      if (cmd === process.execPath && String(args[0]).endsWith("check_partner.mjs")) return { status: 0, stdout: "partner ok", stderr: "" };
      if (cmd === "pnpm") {
        const env = options.env!;
        expect(env.RETROFIT_DEPLOYMENT_ID).toBe(DEPLOYMENT_ID);
        expect(env.RETROFIT_DEPLOYMENT_URL).toBe(DEPLOYMENT_URL);
        expect(env.RETROFIT_RUN_ID).toMatch(/^run_[0-9a-f]{16}$/);
        for (const c of required.filter((x) => x.kind === "e2e-prod" || x.id === "analyze-own-site" || x.id === "judge-path")) {
          writeCaseFile(env.RETROFIT_EVIDENCE_DIR!, caseReport({ caseId: c.id, status: "passed", deploymentId: DEPLOYMENT_ID, deploymentUrl: DEPLOYMENT_URL, commit: COMMIT, runId: env.RETROFIT_RUN_ID! }));
        }
        return { status: 0, stdout: "", stderr: "" };
      }
      throw new Error(`unexpected command ${cmd} ${args.join(" ")}`);
    });
    const ids = ["0".repeat(32), "1".repeat(32), "2".repeat(32), "3".repeat(32), "4".repeat(32)];
    let posted = 0;
    const versionOrigins: string[] = [];
    fetchStub.mockImplementation(async (url: string, init?: RequestInit) => {
      const u = new URL(url);
      versionOrigins.push(u.pathname === "/api/version" ? u.origin : "");
      expect(u.origin).toBe(u.pathname === "/api/version" && u.origin === DEPLOYMENT_URL ? DEPLOYMENT_URL : PROD);
      if (u.pathname === "/api/version") return new Response(JSON.stringify({ commit: COMMIT }), { status: 200 });
      if (u.pathname === "/api/health") return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
      if (u.pathname === "/api/analyze" && init?.method === "POST") {
        expect((init.headers as Record<string, string>).origin).toBe(PROD);
        const id = ids[posted++]!;
        return new Response(JSON.stringify({ id }), { status: 200, headers: { "set-cookie": `retrofit_visitor=v${id}; Path=/; HttpOnly` } });
      }
      if (u.pathname.startsWith("/api/analyze/")) {
        expect((init?.headers as Record<string, string>).cookie).toMatch(/^retrofit_visitor=v/);
        return new Response(JSON.stringify({ status: "ready", step: "ready", scoreReady: true }), { status: 200 });
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const { lines, io } = capture();
    const code = await main([DEPLOYMENT_ID, DEPLOYMENT_URL, COMMIT, "--evidence-dir", tmp], io);
    expect(code, lines.join("\n")).toBe(0);
    expect(posted).toBe(5);
    expect(commands).toContain(`vercel inspect ${DEPLOYMENT_URL} --format json --scope thecreativetoken`);
    expect(commands).toContain("vercel list retrofit --environment preview --scope thecreativetoken");
    expect(commands).toContain("pnpm exec playwright test --config e2e-prod/playwright.config.ts");

    const dir = path.join(tmp, DEPLOYMENT_ID);
    const deployment = JSON.parse(fs.readFileSync(path.join(dir, "deployment.json"), "utf8"));
    expect(deployment).toMatchObject({ deploymentId: DEPLOYMENT_ID, deploymentUrl: DEPLOYMENT_URL, commit: COMMIT, createdAt: new Date(createdAt).toISOString() });
    const concurrent = JSON.parse(fs.readFileSync(path.join(dir, "concurrent-analyses-five.json"), "utf8"));
    expect(concurrent.analyses).toHaveLength(5);
    expect(concurrent.analyses.every((a: { finalStatus: string }) => a.finalStatus === "ready")).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(dir, "partner-harbor-tours.json"), "utf8")).exitCode).toBe(0);

    expect(versionOrigins).toContain(DEPLOYMENT_URL);
    expect(JSON.parse(fs.readFileSync(path.join(dir, "alias-binding.json"), "utf8"))).toMatchObject({ status: "passed", deploymentCommit: COMMIT, aliasCommit: COMMIT, alias: PROD });
    const runId = JSON.parse(fs.readFileSync(path.join(dir, "run.json"), "utf8")).runId;
    expect(runId).toMatch(/^run_[0-9a-f]{16}$/);
    for (const name of fs.readdirSync(dir).filter((n) => n.endsWith(".json") && n !== "deployment.json" && n !== "run.json")) {
      expect(JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")).runId, name).toBe(runId);
    }

    const verdict = productionVerdict(dir);
    expect(verdict.reasons).toEqual([]);
    expect(verdict.passed).toBe(required.length);
  });

  it("refuses to start over earlier reports; --fresh moves them aside and starts a new run", async () => {
    const dir = path.join(tmp, DEPLOYMENT_ID);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "health-ok.json"), JSON.stringify({ case: "health-ok", runId: "run_old" }));
    const { lines, io } = capture();
    expect(await main([DEPLOYMENT_ID, DEPLOYMENT_URL, COMMIT, "--evidence-dir", tmp, "--skip-playwright"], io)).toBe(2);
    expect(lines.join("\n")).toContain("--fresh");
    expect(spawnSync).not.toHaveBeenCalled();
    expect(fetchStub).not.toHaveBeenCalled();
    expect(fs.readdirSync(dir)).toEqual(["health-ok.json"]);

    spawnSync.mockImplementation(() => ({ status: 0, stdout: "", stderr: "" }));
    fetchStub.mockImplementation(async () => new Response(JSON.stringify({ commit: COMMIT, status: "ok" }), { status: 200 }));
    await main([DEPLOYMENT_ID, DEPLOYMENT_URL, COMMIT, "--evidence-dir", tmp, "--skip-playwright", "--fresh", "--created-at", new Date(Date.now() - 1000).toISOString()], io);
    const moved = fs.readdirSync(tmp).filter((n) => n.startsWith(`${DEPLOYMENT_ID}.previous-`));
    expect(moved).toHaveLength(1);
    expect(fs.readdirSync(path.join(tmp, moved[0]!))).toEqual(["health-ok.json"]);
    const runId = JSON.parse(fs.readFileSync(path.join(dir, "run.json"), "utf8")).runId;
    expect(JSON.parse(fs.readFileSync(path.join(dir, "health-ok.json"), "utf8")).runId).toBe(runId);
  });

  it("fails the binding case when the alias serves another commit than the deployment", async () => {
    spawnSync.mockImplementation(() => ({ status: 0, stdout: "", stderr: "" }));
    fetchStub.mockImplementation(async (url: string) => {
      const u = new URL(url);
      if (u.pathname === "/api/version") return new Response(JSON.stringify({ commit: u.origin === DEPLOYMENT_URL ? COMMIT : "c".repeat(40) }), { status: 200 });
      return new Response("{}", { status: 503 });
    });
    const { io } = capture();
    await main([DEPLOYMENT_ID, DEPLOYMENT_URL, COMMIT, "--evidence-dir", tmp, "--skip-playwright", "--created-at", new Date(Date.now() - 1000).toISOString()], io);
    const binding = JSON.parse(fs.readFileSync(path.join(tmp, DEPLOYMENT_ID, "alias-binding.json"), "utf8"));
    expect(binding).toMatchObject({ status: "failed", deploymentCommit: COMMIT, aliasCommit: "c".repeat(40), expected: COMMIT });
  });

  it("records a failed case, not a pass, when /api/version serves another commit", async () => {
    spawnSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "vercel" && args[0] === "inspect") return { status: 1, stdout: "", stderr: "Error: not found" };
      return { status: 0, stdout: "", stderr: "" };
    });
    fetchStub.mockImplementation(async (url: string) => {
      const u = new URL(url);
      if (u.pathname === "/api/version") return new Response(JSON.stringify({ commit: "c".repeat(40) }), { status: 200 });
      if (u.pathname === "/api/health") return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
      return new Response("{}", { status: 503 });
    });
    const { io } = capture();
    // vercel inspect fails, so --created-at is required.
    expect(await main([DEPLOYMENT_ID, DEPLOYMENT_URL, COMMIT, "--evidence-dir", tmp, "--skip-playwright"], io)).toBe(2);
    const code = await main([DEPLOYMENT_ID, DEPLOYMENT_URL, COMMIT, "--evidence-dir", tmp, "--created-at", new Date(Date.now() - 1000).toISOString(), "--skip-playwright"], io);
    expect(code).toBe(1);
    const version = JSON.parse(fs.readFileSync(path.join(tmp, DEPLOYMENT_ID, "version-commit.json"), "utf8"));
    expect(version).toMatchObject({ status: "failed", served: "c".repeat(40), expected: COMMIT });
    expect(JSON.parse(fs.readFileSync(path.join(tmp, DEPLOYMENT_ID, "concurrent-analyses-five.json"), "utf8")).status).toBe("failed");
  });
});
