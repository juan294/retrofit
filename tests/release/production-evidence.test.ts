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
const PEER = "https://demo-harbor.thecreativetoken.com";
const CREATED_AT = () => new Date(Date.now() - 1000).toISOString();

/**
 * `vercel inspect <target>` answers: Vercel's deployment record for each target, in call order
 * (the last answer repeats). A target with no answer fails as the CLI does for an unknown target.
 */
function inspectAnswers(answers: Record<string, (string | null)[]>, extra: Record<string, unknown> = {}) {
  const seen = new Map<string, number>();
  return (target: string) => {
    const list = answers[target];
    if (!list) return { status: 1, stdout: "", stderr: `Error: Can't find the deployment "${target}"` };
    const n = seen.get(target) ?? 0;
    seen.set(target, n + 1);
    const id = list[Math.min(n, list.length - 1)];
    if (id === null) return { status: 1, stdout: "", stderr: `${VERCEL_STDERR(target)}Error: The request timed out\n` };
    return { status: 0, stdout: JSON.stringify({ id, url: target.slice(8), target: "production", ...extra }, null, 2), stderr: VERCEL_STDERR(target) };
  };
}
/** What Vercel CLI 50.23.2 writes to stderr on every call that is not a TTY: its banner and a spinner line. */
const VERCEL_STDERR = (target: string) => `Vercel CLI 50.23.2\nFetching deployment "${target.slice(8)}" in thecreativetoken\n`;
const boundEverywhere = () => inspectAnswers({ [DEPLOYMENT_URL]: [DEPLOYMENT_ID], [PROD]: [DEPLOYMENT_ID], [PEER]: [DEPLOYMENT_ID] }, { createdAt: Date.now() - 60_000 });

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

    const produced = [...out.matchAll(/^step \d+ [a-z-]+ -> (.+)$/gm)].flatMap((m) => m[1]!.split(", ")).filter((id) => id !== "deployment.json" && id !== "nothing yet");
    expect([...new Set(produced)].sort()).toEqual(requiredIds);
    expect(out).toContain(`covers ${requiredIds.length} of ${requiredIds.length} required production cases`);

    // Every outward call is named.
    expect(out).toContain(`$ vercel inspect ${DEPLOYMENT_URL} --format json --scope thecreativetoken`);
    expect(out).toContain(`GET ${PROD}/api/version`);
    expect(out).toContain(`GET ${DEPLOYMENT_URL}/api/version`);
    // The alias identity comes from Vercel, before and after the suites, for the deployment URL, the alias and the peer host.
    for (const target of [DEPLOYMENT_URL, PROD, PEER]) {
      expect(out.split(`$ vercel inspect ${target} --format json --scope thecreativetoken`).length - 1, target).toBeGreaterThanOrEqual(2);
    }
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
    // The binding case's identity window covers every report written here.
    const hosts = { [new URL(DEPLOYMENT_URL).host]: DEPLOYMENT_ID, [new URL(PROD).host]: DEPLOYMENT_ID, [new URL(PEER).host]: DEPLOYMENT_ID };
    const identity = {
      source: "vercel inspect",
      before: { checkedAt: new Date(Date.now() - 1000).toISOString(), deployments: hosts },
      after: { checkedAt: new Date(Date.now() + 60_000).toISOString(), deployments: hosts },
    };
    const kindExtra = (kind: string) => (kind === "partner" ? { exitCode: 0 } : kind === "binding" ? { deploymentCommit: COMMIT, aliasCommit: COMMIT, identity } : {});
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
    const inspect = inspectAnswers({ [DEPLOYMENT_URL]: [DEPLOYMENT_ID], [PROD]: [DEPLOYMENT_ID], [PEER]: [DEPLOYMENT_ID] }, { createdAt });
    const commands: string[] = [];
    spawnSync.mockImplementation((cmd: string, args: string[], options: { env?: Record<string, string> }) => {
      commands.push([path.basename(cmd), ...args].join(" "));
      if (cmd === "vercel" && args[0] === "inspect") return inspect(args[1]!);
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
    const binding = JSON.parse(fs.readFileSync(path.join(dir, "alias-binding.json"), "utf8"));
    expect(binding).toMatchObject({ status: "passed", deploymentCommit: COMMIT, aliasCommit: COMMIT, alias: PROD });
    const hosts = { [new URL(DEPLOYMENT_URL).host]: DEPLOYMENT_ID, [new URL(PROD).host]: DEPLOYMENT_ID, [new URL(PEER).host]: DEPLOYMENT_ID };
    expect(binding.identity.source).toBe("vercel inspect");
    expect(binding.identity.before.deployments).toEqual(hosts);
    expect(binding.identity.after.deployments).toEqual(hosts);
    // Each identity check ran on both sides of the suites: four inspections of each target (record, before, after).
    expect(commands.filter((c) => c === `vercel inspect ${PROD} --format json --scope thecreativetoken`)).toHaveLength(2);
    expect(commands.filter((c) => c === `vercel inspect ${PEER} --format json --scope thecreativetoken`)).toHaveLength(2);
    expect(commands.indexOf(`vercel inspect ${PEER} --format json --scope thecreativetoken`)).toBeLessThan(commands.indexOf("pnpm exec playwright test --config e2e-prod/playwright.config.ts"));
    expect(commands.lastIndexOf(`vercel inspect ${PEER} --format json --scope thecreativetoken`)).toBeGreaterThan(commands.indexOf("pnpm exec playwright test --config e2e-prod/playwright.config.ts"));
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

    const inspect = boundEverywhere();
    spawnSync.mockImplementation((cmd: string, args: string[]) => (cmd === "vercel" && args[0] === "inspect" ? inspect(args[1]!) : { status: 0, stdout: "", stderr: "" }));
    fetchStub.mockImplementation(async () => new Response(JSON.stringify({ commit: COMMIT, status: "ok" }), { status: 200 }));
    await main([DEPLOYMENT_ID, DEPLOYMENT_URL, COMMIT, "--evidence-dir", tmp, "--skip-playwright", "--fresh", "--created-at", CREATED_AT()], io);
    const moved = fs.readdirSync(tmp).filter((n) => n.startsWith(`${DEPLOYMENT_ID}.previous-`));
    expect(moved).toHaveLength(1);
    expect(fs.readdirSync(path.join(tmp, moved[0]!))).toEqual(["health-ok.json"]);
    const runId = JSON.parse(fs.readFileSync(path.join(dir, "run.json"), "utf8")).runId;
    expect(JSON.parse(fs.readFileSync(path.join(dir, "health-ok.json"), "utf8")).runId).toBe(runId);
  });

  it("fails the binding case when the alias serves another commit than the deployment", async () => {
    const inspect = boundEverywhere();
    spawnSync.mockImplementation((cmd: string, args: string[]) => (cmd === "vercel" && args[0] === "inspect" ? inspect(args[1]!) : { status: 0, stdout: "", stderr: "" }));
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
    // Vercel knows the deployment and the aliases but reports no creation time.
    const inspect = inspectAnswers({ [DEPLOYMENT_URL]: [DEPLOYMENT_ID], [PROD]: [DEPLOYMENT_ID], [PEER]: [DEPLOYMENT_ID] });
    spawnSync.mockImplementation((cmd: string, args: string[]) => (cmd === "vercel" && args[0] === "inspect" ? inspect(args[1]!) : { status: 0, stdout: "", stderr: "" }));
    fetchStub.mockImplementation(async (url: string) => {
      const u = new URL(url);
      if (u.pathname === "/api/version") return new Response(JSON.stringify({ commit: "c".repeat(40) }), { status: 200 });
      if (u.pathname === "/api/health") return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
      return new Response("{}", { status: 503 });
    });
    const { io } = capture();
    // vercel inspect gives no creation time, so --created-at is required.
    expect(await main([DEPLOYMENT_ID, DEPLOYMENT_URL, COMMIT, "--evidence-dir", tmp, "--skip-playwright"], io)).toBe(2);
    const code = await main([DEPLOYMENT_ID, DEPLOYMENT_URL, COMMIT, "--evidence-dir", tmp, "--created-at", new Date(Date.now() - 1000).toISOString(), "--skip-playwright"], io);
    expect(code).toBe(1);
    const version = JSON.parse(fs.readFileSync(path.join(tmp, DEPLOYMENT_ID, "version-commit.json"), "utf8"));
    expect(version).toMatchObject({ status: "failed", served: "c".repeat(40), expected: COMMIT });
    expect(JSON.parse(fs.readFileSync(path.join(tmp, DEPLOYMENT_ID, "concurrent-analyses-five.json"), "utf8")).status).toBe("failed");
  });
});

describe("production-evidence.mjs alias identity (V10)", () => {
  /** A run where every /api/version answers the candidate commit and every other probe passes. */
  function healthyProduction() {
    fetchStub.mockImplementation(async (url: string) => {
      const u = new URL(url);
      if (u.pathname === "/api/version") return new Response(JSON.stringify({ commit: COMMIT }), { status: 200 });
      if (u.pathname === "/api/health") return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
      return new Response("{}", { status: 503 });
    });
  }
  function commands(inspect: (target: string) => unknown) {
    const seen: string[] = [];
    spawnSync.mockImplementation((cmd: string, args: string[]) => {
      seen.push([cmd, ...args].join(" "));
      if (cmd === "vercel" && args[0] === "inspect") return inspect(args[1]!);
      return { status: 0, stdout: "partner ok", stderr: "" };
    });
    return seen;
  }
  const binding = () => JSON.parse(fs.readFileSync(path.join(tmp, DEPLOYMENT_ID, "alias-binding.json"), "utf8"));
  const runMain = async () => {
    const { lines, io } = capture();
    const code = await main([DEPLOYMENT_ID, DEPLOYMENT_URL, COMMIT, "--evidence-dir", tmp, "--created-at", CREATED_AT()], io);
    return { code, out: lines.join("\n") };
  };

  // The V10 defect: two deployments of one commit passed, because only /api/version commits were compared.
  it("fails when the alias serves the same commit from another deployment, and runs no suite", async () => {
    healthyProduction();
    const seen = commands(inspectAnswers({ [DEPLOYMENT_URL]: [DEPLOYMENT_ID], [PROD]: ["dpl_samecommitother"], [PEER]: [DEPLOYMENT_ID] }));
    const { code, out } = await runMain();
    expect(code).toBe(1);
    expect(binding()).toMatchObject({ status: "failed" });
    expect(binding().identity.before.deployments[new URL(PROD).host]).toBe("dpl_samecommitother");
    expect(out).toContain(`${new URL(PROD).host} is bound to dpl_samecommitother, not ${DEPLOYMENT_ID}`);
    // Fail closed: no suite runs against an alias that does not serve the candidate.
    expect(seen.some((c) => c.startsWith("pnpm "))).toBe(false);
    expect(fs.existsSync(path.join(tmp, DEPLOYMENT_ID, "health-ok.json"))).toBe(false);
  });

  // Fails if the peer host is not part of the identity (it is host-routed to the same deployment).
  it("fails when the peer host is bound to another deployment", async () => {
    healthyProduction();
    commands(inspectAnswers({ [DEPLOYMENT_URL]: [DEPLOYMENT_ID], [PROD]: [DEPLOYMENT_ID], [PEER]: ["dpl_peerother"] }));
    const { code } = await runMain();
    expect(code).toBe(1);
    expect(binding().status).toBe("failed");
    expect(binding().identity.before.deployments[new URL(PEER).host]).toBe("dpl_peerother");
  });

  // Fails if inspection that cannot answer is treated as a pass (fail closed).
  it("fails closed when Vercel cannot inspect an alias", async () => {
    healthyProduction();
    const seen = commands(inspectAnswers({ [DEPLOYMENT_URL]: [DEPLOYMENT_ID], [PROD]: [null], [PEER]: [DEPLOYMENT_ID] }));
    const { code, out } = await runMain();
    expect(code).toBe(1);
    expect(binding().status).toBe("failed");
    expect(binding().identity.before.deployments[new URL(PROD).host]).toMatch(/^unavailable \(exit 1/);
    expect(out).toContain("alias identity could not be inspected");
    expect(seen.some((c) => c.startsWith("pnpm "))).toBe(false);
  });

  // Fails if the identity is checked only once: an alias moved during the suites must fail the run.
  it("fails when the alias moves to another deployment during the suites", async () => {
    healthyProduction();
    commands(inspectAnswers({ [DEPLOYMENT_URL]: [DEPLOYMENT_ID], [PROD]: [DEPLOYMENT_ID, "dpl_movedduringrun"], [PEER]: [DEPLOYMENT_ID] }));
    const { code } = await runMain();
    expect(code).toBe(1);
    const b = binding();
    expect(b.status).toBe("failed");
    expect(b.identity.before.deployments[new URL(PROD).host]).toBe(DEPLOYMENT_ID);
    expect(b.identity.after.deployments[new URL(PROD).host]).toBe("dpl_movedduringrun");
  });
});

describe("production-evidence.mjs reads vercel inspect from stdout only", () => {
  // Review finding: the CLI's banner and spinner on stderr made every inspection "unavailable".
  it("binds every host when the CLI writes its banner and spinner to stderr", async () => {
    const inspect = boundEverywhere();
    spawnSync.mockImplementation((cmd: string, args: string[]) => (cmd === "vercel" && args[0] === "inspect" ? inspect(args[1]!) : { status: 0, stdout: "", stderr: "" }));
    fetchStub.mockImplementation(async () => new Response(JSON.stringify({ commit: COMMIT, status: "ok" }), { status: 200 }));
    const { io } = capture();
    await main([DEPLOYMENT_ID, DEPLOYMENT_URL, COMMIT, "--evidence-dir", tmp, "--skip-playwright"], io);
    const dir = path.join(tmp, DEPLOYMENT_ID);
    expect(JSON.parse(fs.readFileSync(path.join(dir, "deployment.json"), "utf8")).createdAtSource).toBe("vercel inspect");
    const binding = JSON.parse(fs.readFileSync(path.join(dir, "alias-binding.json"), "utf8"));
    expect(binding.identity.before.deployments).toEqual({ [new URL(DEPLOYMENT_URL).host]: DEPLOYMENT_ID, [new URL(PROD).host]: DEPLOYMENT_ID, [new URL(PEER).host]: DEPLOYMENT_ID });
    expect(binding.status).toBe("passed");
  });

  // Fails if a deployment record that cannot be read is accepted without its id and target checks.
  it("refuses to start when vercel inspect exits 0 but its output is not a deployment record", async () => {
    spawnSync.mockImplementation((cmd: string, args: string[]) =>
      cmd === "vercel" && args[0] === "inspect" ? { status: 0, stdout: "Deployment found\n", stderr: VERCEL_STDERR(args[1]!) } : { status: 0, stdout: "", stderr: "" },
    );
    const { lines, io } = capture();
    expect(await main([DEPLOYMENT_ID, DEPLOYMENT_URL, COMMIT, "--evidence-dir", tmp, "--skip-playwright", "--created-at", CREATED_AT()], io)).toBe(2);
    expect(lines.join("\n")).toContain("vercel inspect exited 0 but gave no deployment record");
    expect(fetchStub).not.toHaveBeenCalled();
  });

  // Fails if the deployment record check accepts a record for another deployment.
  it("refuses a deployment record that names another deployment", async () => {
    const inspect = inspectAnswers({ [DEPLOYMENT_URL]: ["dpl_other"] }, { createdAt: Date.now() - 60_000 });
    spawnSync.mockImplementation((cmd: string, args: string[]) => (cmd === "vercel" && args[0] === "inspect" ? inspect(args[1]!) : { status: 0, stdout: "", stderr: "" }));
    const { lines, io } = capture();
    expect(await main([DEPLOYMENT_ID, DEPLOYMENT_URL, COMMIT, "--evidence-dir", tmp, "--skip-playwright"], io)).toBe(2);
    expect(lines.join("\n")).toContain(`vercel inspect reports deployment dpl_other, not ${DEPLOYMENT_ID}`);
  });
});

describe("analyzer: alias identity in production evidence (V10)", () => {
  const hosts = (id: string) => ({ [new URL(DEPLOYMENT_URL).host]: id, [new URL(PROD).host]: id, [new URL(PEER).host]: id });
  const CREATED = Date.parse("2026-11-16T09:00:00.000Z");
  const iso = (ms: number) => new Date(CREATED + ms).toISOString();
  function evidence(identity: Record<string, unknown> | undefined, recordedAt?: string) {
    const dir = path.join(tmp, DEPLOYMENT_ID);
    fs.mkdirSync(dir, { recursive: true });
    const created = CREATED;
    fs.writeFileSync(path.join(dir, "deployment.json"), JSON.stringify({ deploymentId: DEPLOYMENT_ID, deploymentUrl: DEPLOYMENT_URL, createdAt: new Date(created).toISOString(), commit: COMMIT }));
    fs.writeFileSync(path.join(dir, "run.json"), JSON.stringify({ runId: "run_test0001", deploymentId: DEPLOYMENT_ID }));
    const at = (ms: number) => new Date(created + ms).toISOString();
    for (const c of required) {
      const extra = c.kind === "partner" ? { exitCode: 0 } : c.kind === "binding" ? { deploymentCommit: COMMIT, aliasCommit: COMMIT, ...(identity ? { identity } : {}) } : {};
      writeCaseFile(tmp, caseReport({ caseId: c.id, status: "passed", deploymentId: DEPLOYMENT_ID, deploymentUrl: DEPLOYMENT_URL, commit: COMMIT, runId: "run_test0001", recordedAt: c.kind === "binding" ? at(300_000) : (recordedAt ?? at(200_000)), extra }));
    }
    return { dir, at };
  }
  const window = (before: string, after: string) => ({ source: "vercel inspect", before: { checkedAt: before, deployments: hosts(DEPLOYMENT_ID) }, after: { checkedAt: after, deployments: hosts(DEPLOYMENT_ID) } });
  const messages = (dir: string) => productionVerdict(dir).reasons.map((r: { message: string }) => r.message);

  // Fails if the analyzer accepts a binding case that names no alias deployment (the old commit-only check).
  it("rejects a binding case without an alias identity", () => {
    const { dir } = evidence(undefined);
    expect(messages(dir)).toContain("binding check alias-binding has no alias identity before and after the suites");
  });

  // Fails if a same-commit deployment behind the alias is accepted.
  it("rejects an alias bound to another deployment before or after the suites", () => {
    const w = window(iso(100_000), iso(290_000));
    (w.after.deployments as Record<string, string>)[new URL(PROD).host] = "dpl_samecommitother";
    const { dir } = evidence(w);
    expect(messages(dir)).toContain(`binding check alias-binding after: ${new URL(PROD).host} is bound to dpl_samecommitother, not ${DEPLOYMENT_ID}`);
  });

  // Fails if a required host (the peer) may be left out of the identity.
  it("rejects an identity that leaves out a required host", () => {
    const w = window(iso(100_000), iso(290_000));
    delete (w.before.deployments as Record<string, string>)[new URL(PEER).host];
    const { dir } = evidence(w);
    expect(messages(dir)).toContain(`binding check alias-binding before: ${new URL(PEER).host} is bound to undefined, not ${DEPLOYMENT_ID}`);
  });

  // Fails if a case recorded outside the verified window (before the first or after the last identity check) is accepted.
  it("rejects a case recorded outside the identity window", () => {
    const { dir } = evidence(window(iso(100_000), iso(290_000)), iso(295_000));
    expect(messages(dir)).toContain(`health-ok.json was recorded at ${iso(295_000)}, outside the alias identity checks (${iso(100_000)} to ${iso(290_000)})`);
  });

  // The positive control for the four rejections above.
  it("accepts an identity that binds every host on both sides of every case", () => {
    const { dir } = evidence(window(iso(100_000), iso(290_000)));
    expect(productionVerdict(dir).reasons).toEqual([]);
  });
});
