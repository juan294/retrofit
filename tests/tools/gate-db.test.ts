/**
 * tools/gate-db.mjs against fake `docker`, `supabase` and `pnpm` executables on PATH
 * (tests/tools/shims/fake-cli.mjs). The fakes keep the machine state in a JSON file and log every
 * call, so each test can assert what the tool inspected, started, reset, stopped and left alone.
 * Nothing here reaches the real Docker daemon or the real coordination directory.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { takeOverLock } from "../../tools/gate-db.mjs";

const tool = fileURLToPath(new URL("../../tools/gate-db.mjs", import.meta.url));
const fakeCli = fileURLToPath(new URL("./shims/fake-cli.mjs", import.meta.url));
const MARKER = "GATE-DB TEARDOWN COMPLETE";
const PROJECT_LABEL = "com.supabase.cli.project";
const WORKDIR_LABEL = "com.supabase.cli.workdir";

// The files gate-db writes must not change in the real repository while this suite runs (every
// write belongs under the test's temporary --root). Other evidence (for example the coverage
// report that Vitest writes while this suite runs under the gate) is not gate-db's and is not checked.
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const GATE_DB_OUTPUTS = [".local/evidence/current/vitest-db.json", ".local/evidence/current/gate-db.log"];
function evidenceSnapshot(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rel of GATE_DB_OUTPUTS) {
    const file = path.join(repoRoot, rel);
    out[rel] = fs.existsSync(file) ? createHash("sha256").update(fs.readFileSync(file)).digest("hex") : "absent";
  }
  const gateDir = path.join(repoRoot, ".local", "supabase-gate");
  out[".local/supabase-gate"] = fs.existsSync(gateDir) ? String(fs.statSync(gateDir).mtimeMs) : "absent";
  return out;
}
const realEvidenceBefore = evidenceSnapshot();

type Resource = { id?: string; name: string; labels: Record<string, string>; created: string };
type State = {
  context: string;
  contextHost: string;
  containers: Resource[];
  volumes: Resource[];
  networks: Resource[];
  scenario: Record<string, unknown>;
};
type Call = { tool: string; args: string[]; ppid: number; gateEnv: boolean };

let base: string;
let root: string;
let coord: string;
let bin: string;
let statePath: string;
let callsPath: string;
let env: NodeJS.ProcessEnv;

const gateWorkdir = () => path.join(root, ".local", "supabase-gate");
const logPath = () => path.join(root, ".local", "evidence", "current", "gate-db.log");
const receiptPath = () => path.join(coord, "receipt.json");
const lockPath = () => path.join(coord, "lock");
const readState = (): State => JSON.parse(fs.readFileSync(statePath, "utf8"));
const writeState = (state: State) => fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
const setScenario = (scenario: Record<string, unknown>) => writeState({ ...readState(), scenario });
const calls = (): Call[] =>
  fs.existsSync(callsPath)
    ? fs.readFileSync(callsPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];
const supabaseCalls = (sub?: string) =>
  calls().filter((c) => c.tool === "supabase" && (sub === undefined || c.args[0] === sub || `${c.args[0]} ${c.args[1]}` === sub));
const logLines = () => fs.readFileSync(logPath(), "utf8").split("\n");
const gateResources = (s = readState()) =>
  [...s.containers, ...s.volumes, ...s.networks].filter((r) => r.labels[PROJECT_LABEL] === "retrofit-gate");

function gate(...args: string[]) {
  return spawnSync(process.execPath, [tool, ...args, "--root", root, "--coord-dir", coord], { env, encoding: "utf8" });
}

function stack(project: string, workdir: string): Pick<State, "containers" | "volumes" | "networks"> {
  const labels = { [PROJECT_LABEL]: project, [WORKDIR_LABEL]: workdir };
  return {
    containers: ["db", "rest"].map((s, i) => ({ id: `${project}-${s}-${i}`.padEnd(64, "0"), name: `supabase_${s}_${project}`, labels, created: "2026-11-01T00:00:00Z" })),
    volumes: [{ name: `supabase_db_${project}`, labels: { [PROJECT_LABEL]: project }, created: "2026-11-01T00:00:00Z" }],
    networks: [{ id: `${project}-net`.padEnd(64, "0"), name: `supabase_network_${project}`, labels: { [PROJECT_LABEL]: project }, created: "2026-11-01T00:00:00Z" }],
  };
}

function writeForeignReceipt(pid: number, extra: Record<string, unknown> = {}) {
  fs.mkdirSync(coord, { recursive: true });
  const receipt = {
    runId: "other-run",
    project: "retrofit-gate",
    context: { name: "desktop-linux", host: "unix:///fake/docker.sock", dockerHostEnv: null },
    ports: { first: 54730, last: 54739 },
    worktree: "/elsewhere/worktree",
    gateWorkdir: "/elsewhere/worktree/.local/supabase-gate",
    pid,
    startedAt: "2026-11-01T00:00:00.000Z",
    ...extra,
  };
  fs.writeFileSync(receiptPath(), JSON.stringify(receipt, null, 2));
  return receipt;
}

// A pid that is certainly dead: a child that has already exited and been reaped.
function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
  return Number(child.stdout);
}

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "retrofit-gate-db-")));
  root = path.join(base, "worktree");
  coord = path.join(base, "coord");
  bin = path.join(base, "bin");
  statePath = path.join(base, "state.json");
  callsPath = path.join(base, "calls.log");
  fs.mkdirSync(path.join(root, "supabase", "migrations"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "supabase", "config.toml"),
    [
      'project_id = "retrofit"',
      "[api]",
      "port = 54721",
      "[db]",
      "port = 54722",
      "shadow_port = 54720",
      "[db.pooler]",
      "port = 54729",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(path.join(root, "supabase", "migrations", "20261115120000_store.sql"), "select 1;\n");
  fs.mkdirSync(bin);
  for (const name of ["docker", "supabase", "pnpm"]) {
    const file = path.join(bin, name);
    fs.writeFileSync(file, `#!/bin/sh\nexec "${process.execPath}" "${fakeCli}" ${name} "$@"\n`);
    fs.chmodSync(file, 0o755);
  }
  // The reusable dev stack is present and must never be touched.
  const dev = stack("retrofit", "/Users/dev/code/retrofit");
  writeState({ context: "desktop-linux", contextHost: "unix:///fake/docker.sock", ...dev, scenario: {} });
  env = {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
    HOME: base,
    FAKE_CLI_STATE: statePath,
    FAKE_CLI_CALLS: callsPath,
  };
  delete env.DOCKER_HOST;
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

describe("gate-db run", () => {
  it("gate-db: a clean run starts, verifies, resets, tests, stops, verifies removal and only then writes the teardown line", () => {
    const result = gate();
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);

    const sub = supabaseCalls().map((c) => (c.args[0] === "db" ? `db ${c.args[1]}` : c.args[0]));
    expect(sub).toEqual(["start", "db reset", "status", "stop"]);
    for (const call of supabaseCalls()) expect(call.args).toContain(gateWorkdir());
    expect(supabaseCalls("stop")[0]?.args).toEqual(expect.arrayContaining(["--project-id", "retrofit-gate", "--no-backup"]));
    expect(calls().find((c) => c.tool === "pnpm")?.gateEnv).toBe(true);

    // Generated config: gate identity and gate ports only.
    const toml = fs.readFileSync(path.join(gateWorkdir(), "supabase", "config.toml"), "utf8");
    expect(toml).toMatch(/^project_id = "retrofit-gate"$/m);
    expect(toml).not.toMatch(/5472\d/);
    expect(toml).toMatch(/^port = 54731$/m);
    expect(fs.existsSync(path.join(gateWorkdir(), "supabase", "migrations", "20261115120000_store.sql"))).toBe(true);

    expect(gateResources()).toEqual([]);
    expect(readState().containers.map((c) => c.name)).toEqual(["supabase_db_retrofit", "supabase_rest_retrofit"]);
    expect(fs.existsSync(receiptPath())).toBe(false);
    expect(fs.existsSync(lockPath())).toBe(false);

    const lines = logLines();
    const markerAt = lines.indexOf(MARKER);
    expect(markerAt).toBeGreaterThan(-1);
    expect(lines.findIndex((l) => l.includes("removal verified"))).toBeLessThan(markerAt);
    expect(lines.findIndex((l) => l.includes("receipt deleted"))).toBeLessThan(markerAt);
    // Every step line starts with a timestamp; indented lines are child output or continuations.
    const untimed = lines.slice(0, markerAt).filter((l) => l !== "" && !/^\s/.test(l) && !/^\d{4}-\d\d-\d\dT[\d:.]+Z /.test(l));
    expect(untimed).toEqual([]);
    expect(fs.readFileSync(logPath(), "utf8")).not.toContain("eyJ");
  });

  it("gate-db: two concurrent runs, the second exits 1 naming the holder and touches nothing", async () => {
    const go = path.join(base, "go");
    setScenario({ vitestWaitFor: go });
    const first = spawn(process.execPath, [tool, "--root", root, "--coord-dir", coord], { env, stdio: "ignore" });
    const firstExit = new Promise<number | null>((resolve) => first.on("exit", (code) => resolve(code)));
    const deadline = Date.now() + 20_000;
    while (!calls().some((c) => c.tool === "pnpm")) {
      if (Date.now() > deadline) throw new Error("first run never reached the tests");
      await new Promise((r) => setTimeout(r, 50));
    }
    const callsBefore = calls().length;

    const otherRoot = path.join(base, "other-worktree");
    fs.cpSync(path.join(root, "supabase"), path.join(otherRoot, "supabase"), { recursive: true });
    const second = spawnSync(process.execPath, [tool, "--root", otherRoot, "--coord-dir", coord], { env, encoding: "utf8" });
    expect(second.status).toBe(1);
    expect(second.stderr).toContain(`pid ${first.pid}`);
    expect(second.stderr).toContain(root);
    expect(second.stderr).toMatch(/started \d{4}-\d\d-\d\dT/);
    expect(calls().length).toBe(callsBefore);

    fs.writeFileSync(go, "");
    expect(await firstExit).toBe(0);
    expect(gateResources()).toEqual([]);
  });

  it("gate-db: an inherited retrofit-gate stack without a receipt is refused; nothing is started, reset or stopped", () => {
    const inherited = stack("retrofit-gate", "/somewhere/else/.local/supabase-gate");
    const state = readState();
    writeState({ ...state, containers: [...state.containers, ...inherited.containers], volumes: [...state.volumes, ...inherited.volumes], networks: [...state.networks, ...inherited.networks] });
    const before = readState();

    const result = gate();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Found a retrofit-gate stack this run did not create");
    expect(result.stderr).toContain("supabase_db_retrofit-gate");
    expect(result.stderr).toContain("gate-db:recover");
    expect(supabaseCalls()).toEqual([]);
    expect(calls().some((c) => c.tool === "pnpm")).toBe(false);
    expect(readState()).toEqual(before);
    expect(fs.existsSync(receiptPath())).toBe(false);
    expect(fs.existsSync(lockPath())).toBe(false);
    expect(logLines()).not.toContain(MARKER);
  });

  it("gate-db: a resource named for retrofit-gate without the project label is refused as unknown", () => {
    const state = readState();
    state.volumes.push({ name: "supabase_db_retrofit-gate", labels: {}, created: "2026-11-01T00:00:00Z" });
    writeState(state);
    const result = gate();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("supabase_db_retrofit-gate");
    expect(supabaseCalls()).toEqual([]);
  });

  it("gate-db: a receipt from another run is refused and left unchanged", () => {
    const receipt = writeForeignReceipt(deadPid());
    const before = fs.readFileSync(receiptPath(), "utf8");
    const result = gate();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`pid ${receipt.pid}`);
    expect(result.stderr).toContain("/elsewhere/worktree");
    expect(supabaseCalls()).toEqual([]);
    expect(fs.readFileSync(receiptPath(), "utf8")).toBe(before);
    expect(fs.existsSync(lockPath())).toBe(false);
  });

  it("gate-db: a container replaced between the verify steps is not disposed and the run reports it", () => {
    setScenario({ vitestReplaceContainer: "supabase_rest_retrofit-gate" });
    const result = gate();
    expect(result.status).toBe(8);
    expect(result.stderr).toMatch(/supabase_rest_retrofit-gate.*replaced/);
    expect(supabaseCalls("stop")).toEqual([]);
    expect(gateResources().length).toBeGreaterThan(0);
    expect(fs.existsSync(receiptPath())).toBe(true);
    expect(fs.existsSync(lockPath())).toBe(false);
    expect(logLines()).not.toContain(MARKER);

    // Recovery also refuses: the replaced container is not the recorded resource.
    const recover = gate("recover");
    expect(recover.status).toBe(1);
    expect(recover.stderr).toMatch(/supabase_rest_retrofit-gate/);
    expect(supabaseCalls("stop")).toEqual([]);
    expect(fs.existsSync(receiptPath())).toBe(true);
  });

  it("gate-db: a test failure still disposes and releases, with exit 4 and the teardown line", () => {
    setScenario({ vitestExit: 1 });
    const result = gate();
    expect(result.status).toBe(4);
    expect(result.stderr).toContain("first failure: vitest db project exited 1");
    expect(result.stderr).not.toContain("cleanup failure");
    expect(supabaseCalls("stop").length).toBe(1);
    expect(gateResources()).toEqual([]);
    expect(fs.existsSync(receiptPath())).toBe(false);
    expect(fs.existsSync(lockPath())).toBe(false);
    expect(logLines()).toContain(MARKER);
  });

  it("gate-db: a cleanup failure is reported separately from a test failure", () => {
    setScenario({ vitestExit: 1, stopExit: 1 });
    const result = gate();
    expect(result.status).toBe(12);
    expect(result.stderr).toContain("first failure: vitest db project exited 1");
    expect(result.stderr).toContain("cleanup failure: supabase stop exited 1");
    const log = fs.readFileSync(logPath(), "utf8");
    expect(log).toContain("first failure: vitest db project exited 1");
    expect(log).toContain("cleanup failure: supabase stop exited 1");
    expect(logLines()).not.toContain(MARKER);
    expect(fs.existsSync(receiptPath())).toBe(true);
    expect(fs.existsSync(lockPath())).toBe(false);
  });

  it("gate-db: the teardown line is not written when stop succeeds but a volume remains", () => {
    setScenario({ stopLeaves: ["volume"] });
    const result = gate();
    expect(result.status).toBe(8);
    expect(result.stderr).toContain("cleanup failure: removal not verified");
    expect(result.stderr).toContain("supabase_db_retrofit-gate");
    expect(logLines()).not.toContain(MARKER);
    expect(fs.existsSync(receiptPath())).toBe(true);
  });

  it("gate-db: a Docker inspection failure is not treated as a clean inventory", () => {
    setScenario({ dockerFail: "volume ls" });
    const result = gate();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Docker inspection failed");
    expect(supabaseCalls()).toEqual([]);
    expect(fs.existsSync(receiptPath())).toBe(false);
  });

  it("gate-db: writes vitest-db.json under --root and requires the full JSON reporter output", () => {
    const report = path.join(root, ".local", "evidence", "current", "vitest-db.json");
    expect(gate().status).toBe(0);
    const json = JSON.parse(fs.readFileSync(report, "utf8"));
    expect(json.testResults[0].assertionResults[0].status).toBe("passed");

    setScenario({ vitestReportMinimal: true });
    const result = gate();
    expect(result.status).toBe(4);
    expect(result.stderr).toContain("first failure: vitest-db.json has no testResults with assertionResults");
    expect(logLines()).toContain(MARKER);
  });

  it("gate-db: an unexpected error while inspecting releases the lock because nothing was started", () => {
    setScenario({ contextInspectGarbage: true });
    const result = gate();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unexpected error before anything was started");
    expect(supabaseCalls()).toEqual([]);
    expect(fs.existsSync(lockPath())).toBe(false);
    expect(fs.existsSync(receiptPath())).toBe(false);
  });
});

describe("gate-db lock takeover", () => {
  const deadLock = (pid: number) => JSON.stringify({ runId: "dead-run", pid, worktree: "/elsewhere/worktree", startedAt: "2026-11-01T00:00:00.000Z" }, null, 2);
  const identity = (runId: string) => ({ runId, pid: process.pid, worktree: root, startedAt: new Date().toISOString() });

  it("gate-db: two recovers that read the same dead lock cannot both take it over", () => {
    fs.mkdirSync(coord, { recursive: true });
    const dead = deadLock(deadPid());
    fs.writeFileSync(lockPath(), dead);
    // Both recovers read the same dead lock; the first takes over, then the second tries.
    const first = takeOverLock(lockPath(), dead, identity("recover-a"));
    expect(first.ok).toBe(true);
    const lockAfterFirst = fs.readFileSync(lockPath(), "utf8");
    expect(JSON.parse(lockAfterFirst).runId).toBe("recover-a");

    const second = takeOverLock(lockPath(), dead, identity("recover-b"));
    expect(second.ok).toBe(false);
    expect(fs.readFileSync(lockPath(), "utf8")).toBe(lockAfterFirst);
  });

  it("gate-db: a takeover marker held by another recover blocks the takeover", () => {
    fs.mkdirSync(coord, { recursive: true });
    const dead = deadLock(deadPid());
    fs.writeFileSync(lockPath(), dead);
    fs.writeFileSync(`${lockPath()}.takeover`, JSON.stringify({ pid: process.pid }));
    const result = takeOverLock(lockPath(), dead, identity("recover-c"));
    expect(result.ok).toBe(false);
    expect(fs.readFileSync(lockPath(), "utf8")).toBe(dead);
  });
});

describe("gate-db recover", () => {
  it("gate-db: a refused recover never overwrites a lock another run acquired meanwhile", () => {
    const pid = deadPid();
    writeForeignReceipt(pid);
    fs.writeFileSync(lockPath(), JSON.stringify({ runId: "other-run", pid, worktree: "/elsewhere/worktree", startedAt: "2026-11-01T00:00:00.000Z" }));
    const newLock = JSON.stringify({ runId: "new-run", pid: process.pid, worktree: "/third/worktree", startedAt: new Date().toISOString() });
    // The context differs from the receipt, so recover refuses; meanwhile another run writes the lock.
    writeState({ ...readState(), context: "another-context", scenario: { writeLockOnContextShow: { path: lockPath(), content: newLock } } });
    const result = gate("recover");
    expect(result.status).toBe(1);
    expect(fs.readFileSync(lockPath(), "utf8")).toBe(newLock);
    expect(fs.existsSync(receiptPath())).toBe(true);
  });

  it("gate-db: an interrupted run leaves a receipt that recover disposes when its pid is dead", () => {
    setScenario({ vitestKillParent: true });
    const killed = gate();
    expect(killed.signal).toBe("SIGKILL");
    expect(fs.existsSync(receiptPath())).toBe(true);
    expect(fs.existsSync(lockPath())).toBe(true);
    expect(gateResources().length).toBeGreaterThan(0);

    setScenario({});
    const result = gate("recover");
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(supabaseCalls("stop").length).toBe(1);
    expect(gateResources()).toEqual([]);
    expect(readState().containers.map((c) => c.name)).toEqual(["supabase_db_retrofit", "supabase_rest_retrofit"]);
    expect(fs.existsSync(receiptPath())).toBe(false);
    expect(fs.readdirSync(coord)).toEqual([]);

    // A later run starts normally.
    expect(gate().status).toBe(0);
  });

  it("gate-db: recover leaves a receipt alone while its pid is alive", () => {
    const resources = stack("retrofit-gate", "/elsewhere/worktree/.local/supabase-gate");
    const state = readState();
    writeState({ ...state, containers: [...state.containers, ...resources.containers], volumes: [...state.volumes, ...resources.volumes], networks: [...state.networks, ...resources.networks] });
    writeForeignReceipt(process.pid);
    const before = readState();
    const result = gate("recover");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`pid ${process.pid} is alive`);
    expect(supabaseCalls()).toEqual([]);
    expect(readState()).toEqual(before);
    expect(fs.existsSync(receiptPath())).toBe(true);
  });

  it("gate-db: recover refuses resources that do not match the receipt", () => {
    const resources = stack("retrofit-gate", "/a/different/workdir");
    const state = readState();
    writeState({ ...state, containers: [...state.containers, ...resources.containers], volumes: [...state.volumes, ...resources.volumes], networks: [...state.networks, ...resources.networks] });
    writeForeignReceipt(deadPid(), {
      resources: { containers: [], volumes: [], networks: [] },
    });
    const result = gate("recover");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("does not match the receipt");
    expect(supabaseCalls()).toEqual([]);
    expect(fs.existsSync(receiptPath())).toBe(true);
  });

  it("gate-db: recover with no receipt reports nothing to recover", () => {
    const result = gate("recover");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("nothing to recover");
    expect(supabaseCalls()).toEqual([]);
  });
});

describe("gate-db test isolation", () => {
  it("gate-db: the suite leaves the real repository's gate-db outputs unchanged", () => {
    expect(evidenceSnapshot()).toEqual(realEvidenceBefore);
  });
});
