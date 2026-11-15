#!/usr/bin/env node
// Runs the Vitest `db` project against a disposable Supabase stack and removes that stack.
//
//   node tools/gate-db.mjs          [--root <worktree>] [--coord-dir <dir>]   (pnpm test:db)
//   node tools/gate-db.mjs recover  [--root <worktree>] [--coord-dir <dir>]   (pnpm gate-db:recover)
//
// The stack has the identity `retrofit-gate` on ports 54730 to 54739. Its configuration is
// generated from supabase/ into .local/supabase-gate/. The reusable dev stack `retrofit`, every
// other project and every resource without the retrofit-gate label are never touched, and nothing
// is pruned (docs/development/resource-lifecycle.md, .rpi/rules/resource-lifecycle.md).
//
// Coordination directory (machine wide, outside every worktree; default
// ~/Library/Application Support/retrofit/gate-db/):
//   lock          created exclusively; holder pid, worktree, start time and run id.
//   receipt.json  created exclusively before the stack starts (never replaces another receipt);
//                 Docker context, project, ports, worktree, pid, start time, and the verified
//                 container, volume and network identities once the stack is up.
//
// Run exit status: 0 tests passed and teardown complete; 1 refused before anything was started
// (lock held, receipt present, retrofit-gate resources present, Docker inspection failed);
// 2 usage error; otherwise a bit mask: 4 = run failure (start, reset, status, tests or an
// interruption), 8 = cleanup failure (identity changed, stop failed or removal not verified).
// The first run failure and any cleanup failure are reported separately.
// Recover exit status: 0 disposed or nothing to recover; 1 refused, everything left in place;
// 2 usage error; 8 cleanup failure.
//
// Every step is logged with a timestamp to .local/evidence/current/gate-db.log. The line
// `GATE-DB TEARDOWN COMPLETE` is written only after the stack was stopped, its removal verified
// and the receipt deleted. Secrets from `supabase start` and `supabase status` are never logged.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GATE_DB_TEARDOWN_MARKER } from "./release/analyze-evidence.mjs";

const PROJECT = "retrofit-gate";
const LABEL_PROJECT = "com.supabase.cli.project";
const LABEL_WORKDIR = "com.supabase.cli.workdir";
const PORTS = { first: 54730, last: 54739 };
const DEV_PORT = /\b5472(\d)\b/g;
const EXIT = { ok: 0, refused: 1, usage: 2, runFailed: 4, cleanupFailed: 8 };
const CURRENT = path.join(".local", "evidence", "current");
const VITEST_REPORT = path.join(CURRENT, "vitest-db.json");
const DEFAULT_COORD = path.join(os.homedir(), "Library", "Application Support", "retrofit", "gate-db");
const USAGE = "usage: gate-db.mjs [recover] [--root <worktree>] [--coord-dir <dir>]";

class UsageError extends Error {}
class Refusal extends Error {}

function parseArgs(argv) {
  const options = { command: "run", root: process.cwd(), coordDir: DEFAULT_COORD };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) throw new UsageError(`${arg} needs a value\n${USAGE}`);
      return argv[++i];
    };
    if (arg === "--root") options.root = path.resolve(value());
    else if (arg === "--coord-dir") options.coordDir = path.resolve(value());
    else if (arg === "recover" && i === 0) options.command = "recover";
    else throw new UsageError(`unexpected argument: ${arg}\n${USAGE}`);
  }
  options.root = fs.realpathSync(options.root);
  return options;
}

// ---------------------------------------------------------------- logging and processes

const secrets = new Set();
function redact(text) {
  let out = String(text)
    .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, "[redacted]")
    .replace(/sb_(secret|publishable)_[\w-]+/g, "[redacted]")
    .replace(/(postgres(?:ql)?:\/\/[^:\s/]+:)[^@\s]+@/g, "$1[redacted]@");
  for (const secret of secrets) out = out.split(secret).join("[redacted]");
  return out;
}

function createLog(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "");
  const append = (text) => fs.appendFileSync(file, text);
  return {
    file,
    step(message) {
      const line = `${new Date().toISOString()} ${redact(message)}`;
      append(`${line}\n`);
      process.stdout.write(`${line}\n`);
    },
    problem(message) {
      const line = `${new Date().toISOString()} ${redact(message)}`;
      append(`${line}\n`);
      process.stderr.write(`gate-db: ${redact(message)}\n`);
    },
    marker(text) {
      append(`${text}\n`);
      process.stdout.write(`${text}\n`);
    },
    output(text) {
      // Child output, indented so every log line that is not output starts with a timestamp.
      const body = redact(text).replace(/\n$/, "");
      if (body) append(`${body.split("\n").map((l) => `    | ${l}`).join("\n")}\n`);
    },
  };
}

let currentChild = null;

// Runs a command without a shell. Children get their own process group so a terminal Ctrl-C
// reaches only this tool, which then disposes in order. `quiet` keeps stdout out of the log.
function run(log, command, args, { env = process.env, quiet = false, tee = false } = {}) {
  log.step(`$ ${command} ${args.join(" ")}`);
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let child;
    try {
      child = spawn(command, args, { env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      log.step(`  could not start ${command}: ${error.message}`);
      resolve({ code: null, stdout, stderr: error.message });
      return;
    }
    currentChild = child;
    child.stdout.on("data", (d) => {
      stdout += d;
      if (tee) {
        process.stdout.write(redact(d));
        log.output(String(d));
      }
    });
    child.stderr.on("data", (d) => {
      stderr += d;
      if (tee) process.stderr.write(redact(d));
    });
    child.on("error", (error) => {
      stderr += error.message;
    });
    child.on("close", (code, signal) => {
      currentChild = null;
      if (!tee) {
        if (!quiet) log.output(stdout);
        log.output(stderr);
      } else {
        log.output(stderr);
      }
      log.step(`  exit ${code ?? signal}`);
      resolve({ code: code ?? (signal ? 128 : null), stdout, stderr });
    });
  });
}

// ---------------------------------------------------------------- Docker inspection

async function dockerContext(log) {
  const show = await run(log, "docker", ["context", "show"]);
  if (show.code !== 0) throw new Refusal(`Docker inspection failed: docker context show exited ${show.code}: ${show.stderr.trim()}`);
  const name = show.stdout.trim();
  const inspect = await run(log, "docker", ["context", "inspect", name]);
  if (inspect.code !== 0) throw new Refusal(`Docker inspection failed: docker context inspect exited ${inspect.code}: ${inspect.stderr.trim()}`);
  const host = JSON.parse(inspect.stdout)[0]?.Endpoints?.docker?.Host ?? null;
  return { name, host, dockerHostEnv: process.env.DOCKER_HOST ?? null };
}

const sameContext = (a, b) => a.name === b.name && a.host === b.host && a.dockerHostEnv === b.dockerHostEnv;

async function lines(log, args) {
  const result = await run(log, "docker", args);
  if (result.code !== 0) throw new Refusal(`Docker inspection failed: docker ${args.join(" ")} exited ${result.code}: ${result.stderr.trim()}`);
  return result.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
}

async function inspectJson(log, args) {
  const result = await run(log, "docker", args, { quiet: true });
  if (result.code !== 0) throw new Refusal(`Docker inspection failed: docker ${args.slice(0, 2).join(" ")} exited ${result.code}: ${result.stderr.trim()}`);
  return JSON.parse(result.stdout);
}

// Everything labelled for retrofit-gate, plus anything named for it without that label (unknown,
// so it blocks the run and is never disposed). Throws Refusal on any inspection failure.
async function inventory(log) {
  const byLabel = `label=${LABEL_PROJECT}=${PROJECT}`;
  const byName = `name=${PROJECT}`;
  const ownName = (name) => name.replace(/^\//, "").endsWith(`_${PROJECT}`);
  const union = (a, b) => [...new Set([...a, ...b])];

  const containerIds = union(
    await lines(log, ["ps", "-a", "-q", "--no-trunc", "--filter", byLabel]),
    await lines(log, ["ps", "-a", "-q", "--no-trunc", "--filter", byName]),
  );
  const volumeNames = union(
    await lines(log, ["volume", "ls", "-q", "--filter", byLabel]),
    await lines(log, ["volume", "ls", "-q", "--filter", byName]),
  );
  const networkIds = union(
    await lines(log, ["network", "ls", "-q", "--no-trunc", "--filter", byLabel]),
    await lines(log, ["network", "ls", "-q", "--no-trunc", "--filter", byName]),
  );

  const containers = containerIds.length
    ? (await inspectJson(log, ["inspect", "--type", "container", ...containerIds])).map((c) => ({
        id: c.Id,
        name: c.Name.replace(/^\//, ""),
        created: c.Created,
        labels: c.Config?.Labels ?? {},
      }))
    : [];
  const volumes = volumeNames.length
    ? (await inspectJson(log, ["volume", "inspect", ...volumeNames])).map((v) => ({ name: v.Name, created: v.CreatedAt, labels: v.Labels ?? {} }))
    : [];
  const networks = networkIds.length
    ? (await inspectJson(log, ["network", "inspect", ...networkIds])).map((n) => ({ id: n.Id, name: n.Name, created: n.Created, labels: n.Labels ?? {} }))
    : [];

  const relevant = (r) => r.labels[LABEL_PROJECT] === PROJECT || ownName(r.name);
  const inv = { containers: containers.filter(relevant), volumes: volumes.filter(relevant), networks: networks.filter(relevant) };
  inv.unlabelled = [...inv.containers, ...inv.volumes, ...inv.networks].filter((r) => r.labels[LABEL_PROJECT] !== PROJECT);
  inv.count = inv.containers.length + inv.volumes.length + inv.networks.length;
  return inv;
}

function describeInventory(inv) {
  const items = [
    ...inv.containers.map((c) => `container ${c.name} ${c.id.slice(0, 12)} (workdir ${c.labels[LABEL_WORKDIR] ?? "none"})`),
    ...inv.volumes.map((v) => `volume ${v.name}`),
    ...inv.networks.map((n) => `network ${n.name} ${n.id.slice(0, 12)}`),
  ];
  return items.map((i) => `  - ${i}`).join("\n");
}

const snapshot = (inv) => ({
  containers: inv.containers.map((c) => ({ id: c.id, name: c.name })),
  volumes: inv.volumes.map((v) => ({ name: v.name, created: v.created })),
  networks: inv.networks.map((n) => ({ id: n.id, name: n.name })),
});

// Problems that stop this stack from being treated as the one started from `gateWorkdir`.
function labelProblems(inv, gateWorkdir) {
  const problems = inv.unlabelled.map((r) => `${r.name} has no ${LABEL_PROJECT}=${PROJECT} label`);
  for (const c of inv.containers) {
    if (c.labels[LABEL_WORKDIR] !== gateWorkdir) problems.push(`container ${c.name} has workdir ${c.labels[LABEL_WORKDIR] ?? "none"}, expected ${gateWorkdir}`);
  }
  return problems;
}

// Differences between a recorded snapshot and the current inventory. `allowMissing` accepts
// recorded resources that are already gone (a partial teardown before an interruption).
function identityProblems(recorded, inv, { allowMissing = false } = {}) {
  const problems = [];
  const compare = (kind, before, now, key) => {
    for (const r of now) {
      const match = before.find((b) => b[key] === r[key] && (kind !== "volume" || b.created === r.created));
      if (match) continue;
      const sameName = before.find((b) => b.name === r.name);
      problems.push(sameName ? `${kind} ${r.name} was replaced (recorded ${String(sameName[key]).slice(0, 12)}, now ${String(r[key] ?? r.created).slice(0, 12)})` : `${kind} ${r.name} is not in the record`);
    }
    if (!allowMissing) {
      for (const b of before) if (!now.some((r) => r.name === b.name)) problems.push(`${kind} ${b.name} disappeared`);
    }
  };
  compare("container", recorded.containers, inv.containers, "id");
  compare("volume", recorded.volumes, inv.volumes, "name");
  compare("network", recorded.networks, inv.networks, "id");
  return problems;
}

// ---------------------------------------------------------------- coordination files

const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};
const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
};
const holderText = (h) => `pid ${h.pid} (worktree ${h.worktree}, started ${h.startedAt})`;

function acquireLock(lockFile, identity) {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  try {
    fs.writeFileSync(lockFile, JSON.stringify(identity, null, 2), { flag: "wx" });
    return null;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    return readJson(lockFile) ?? { pid: "unknown", worktree: "unknown", startedAt: "unknown" };
  }
}

function releaseLock(lockFile, runId) {
  const holder = readJson(lockFile);
  if (holder?.runId === runId) fs.rmSync(lockFile);
}

function writeReceiptOnce(file, receipt) {
  fs.writeFileSync(file, JSON.stringify(receipt, null, 2), { flag: "wx" });
}

// Adds the verified identities to this run's own receipt; never touches another run's receipt.
function amendReceipt(file, runId, fields) {
  const receipt = readJson(file);
  if (receipt?.runId !== runId) throw new Error(`receipt ${file} no longer belongs to this run`);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ ...receipt, ...fields }, null, 2));
  fs.renameSync(tmp, file);
}

// ---------------------------------------------------------------- gate configuration

function generateGateConfig(root, gateWorkdir) {
  const source = path.join(root, "supabase");
  if (!fs.existsSync(path.join(source, "config.toml"))) throw new Error(`${source}/config.toml is missing`);
  fs.rmSync(gateWorkdir, { recursive: true, force: true });
  const dest = path.join(gateWorkdir, "supabase");
  // Dot entries (.temp, .branches, .env) belong to the dev identity or hold local secrets.
  fs.cpSync(source, dest, { recursive: true, filter: (src) => src === source || !path.basename(src).startsWith(".") });
  const file = path.join(dest, "config.toml");
  let toml = fs.readFileSync(file, "utf8");
  if (!/^project_id\s*=/m.test(toml)) throw new Error("supabase/config.toml has no project_id");
  toml = toml.replace(/^project_id\s*=.*$/m, `project_id = "${PROJECT}"`).replace(DEV_PORT, "5473$1");
  for (const match of toml.matchAll(/^\s*[a-z_]*port\s*=\s*(\d+)/gm)) {
    const port = Number(match[1]);
    if (port < PORTS.first || port > PORTS.last) throw new Error(`generated gate config has port ${port} outside ${PORTS.first}-${PORTS.last}`);
  }
  fs.writeFileSync(file, toml);
}

function gateEnvFromStatus(stdout) {
  const json = JSON.parse(stdout.slice(stdout.indexOf("{"), stdout.lastIndexOf("}") + 1));
  const url = json.API_URL;
  const key = json.SERVICE_ROLE_KEY ?? json.SECRET_KEY;
  const dbUrl = json.DB_URL;
  if (!url || !key || !dbUrl) throw new Error("supabase status did not report API_URL, SERVICE_ROLE_KEY and DB_URL");
  for (const [name, value] of [["API_URL", url], ["DB_URL", dbUrl]]) {
    const port = Number(new URL(value).port);
    if (port < PORTS.first || port > PORTS.last) throw new Error(`supabase status ${name} uses port ${port}, not a gate port`);
  }
  secrets.add(key);
  return { SUPABASE_GATE_URL: url, SUPABASE_GATE_SERVICE_ROLE_KEY: key, SUPABASE_GATE_DB_URL: dbUrl };
}

// ---------------------------------------------------------------- disposal

// Stops the verified stack with --no-backup and verifies that nothing labelled for it remains.
// Returns null on verified removal, or the cleanup failure text.
async function dispose(log, gateWorkdir) {
  const stop = await run(log, "supabase", ["stop", "--project-id", PROJECT, "--no-backup", "--workdir", gateWorkdir]);
  if (stop.code !== 0) return `supabase stop exited ${stop.code}: ${stop.stderr.trim().split("\n").at(-1) ?? ""}`;
  let after;
  try {
    after = await inventory(log);
  } catch (error) {
    return `removal not verified: ${error.message}`;
  }
  if (after.count > 0) return `removal not verified; these remain:\n${describeInventory(after)}`;
  log.step("removal verified: no retrofit-gate container, volume or network remains");
  return null;
}

// ---------------------------------------------------------------- run

async function runGateDb({ root, coordDir }) {
  const lockFile = path.join(coordDir, "lock");
  const receiptFile = path.join(coordDir, "receipt.json");
  const gateWorkdir = path.join(root, ".local", "supabase-gate");
  const logFile = path.join(root, CURRENT, "gate-db.log");
  const runId = randomBytes(8).toString("hex");
  const startedAt = new Date().toISOString();
  const identity = { runId, pid: process.pid, worktree: root, startedAt };

  // 1. machine-wide lock
  const holder = acquireLock(lockFile, identity);
  if (holder) {
    const message =
      `gate database lock ${lockFile} is held by ${holderText(holder)}. ` +
      `Wait for that run to finish; if that pid is dead, run pnpm gate-db:recover.`;
    // Do not truncate the log of a run in progress in this same worktree.
    if (holder.worktree !== root) createLog(logFile).problem(message);
    else process.stderr.write(`gate-db: ${message}\n`);
    return EXIT.refused;
  }

  const log = createLog(logFile);
  log.step(`gate-db run ${runId}: pid ${process.pid}, worktree ${root}, coordination ${coordDir}`);
  log.step("step 1: lock acquired");
  let runFailure = null;
  let cleanupFailure = null;
  const fail = (text) => {
    if (!runFailure) runFailure = text;
    log.problem(`run failure: ${text}`);
  };
  let interrupted = null;
  const onSignal = (signal) => {
    if (interrupted) {
      log.problem(`second ${signal}: exiting without teardown; ${receiptFile} is kept for pnpm gate-db:recover`);
      process.exit(130);
    }
    interrupted = signal;
    fail(`interrupted by ${signal}`);
    if (currentChild?.pid) {
      try {
        process.kill(-currentChild.pid, "SIGTERM");
      } catch {
        // The child already exited.
      }
    }
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  let context;
  try {
    // 2. inspect
    log.step("step 2: inspect the Docker context and retrofit-gate resources");
    context = await dockerContext(log);
    log.step(`docker context ${context.name} (${context.host}); DOCKER_HOST ${context.dockerHostEnv ?? "unset"}`);
    const existing = await inventory(log);

    // 3. refuse inherited or foreign state
    const receipt = readJson(receiptFile);
    if (receipt) {
      throw new Refusal(
        `${receiptFile} belongs to another run: ${holderText(receipt)}. ` +
          `Nothing was started, reset or stopped. If that run is dead, run pnpm gate-db:recover.`,
      );
    }
    if (existing.count > 0) {
      throw new Refusal(
        `Found a retrofit-gate stack this run did not create. Nothing was reset or removed:\n${describeInventory(existing)}\n` +
          `If an interrupted gate run left it, run pnpm gate-db:recover; otherwise find its owner.`,
      );
    }
    log.step("step 3: no receipt and no retrofit-gate resources");
  } catch (error) {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    if (!(error instanceof Refusal)) throw error;
    log.problem(error.message);
    releaseLock(lockFile, runId);
    log.step("lock released; refused");
    return EXIT.refused;
  }

  // 4. receipt, configuration, start
  let recorded = null;
  try {
    generateGateConfig(root, gateWorkdir);
    log.step(`step 4: generated ${path.join(gateWorkdir, "supabase", "config.toml")} (project ${PROJECT}, ports ${PORTS.first}-${PORTS.last})`);
    writeReceiptOnce(receiptFile, {
      runId,
      project: PROJECT,
      context,
      ports: PORTS,
      worktree: root,
      gateWorkdir,
      pid: process.pid,
      startedAt,
    });
    log.step(`receipt written: ${receiptFile}`);
  } catch (error) {
    fail(`could not prepare the gate stack: ${error.message}`);
    releaseLock(lockFile, runId);
    return finish(log, runFailure, null);
  }

  const start = interrupted ? null : await run(log, "supabase", ["start", "--workdir", gateWorkdir], { quiet: true });
  if (start && start.code !== 0) fail(`supabase start exited ${start.code}`);

  // 5. verify, record, reset, test
  const verifyAndRecord = async (label) => {
    const inv = await inventory(log);
    const problems = labelProblems(inv, gateWorkdir);
    if (problems.length > 0) throw new Refusal(`identity check ${label} failed:\n  - ${problems.join("\n  - ")}`);
    recorded = snapshot(inv);
    amendReceipt(receiptFile, runId, { resources: recorded, recordedAt: new Date().toISOString() });
    log.step(`identity ${label}: ${inv.containers.length} containers carry ${LABEL_PROJECT}=${PROJECT} and workdir ${gateWorkdir}`);
    for (const c of recorded.containers) log.step(`  container ${c.name} ${c.id}`);
    for (const v of recorded.volumes) log.step(`  volume ${v.name}`);
    for (const n of recorded.networks) log.step(`  network ${n.name} ${n.id}`);
  };

  let identityFailure = null;
  try {
    log.step("step 5: verify the started stack");
    await verifyAndRecord("after start");
    if (!runFailure) {
      const reset = await run(log, "supabase", ["db", "reset", "--local", "--workdir", gateWorkdir]);
      if (reset.code !== 0) fail(`supabase db reset exited ${reset.code}`);
      // A local reset recreates the database container; record the identities it left.
      await verifyAndRecord("after reset");
    }
    if (!runFailure) {
      const status = await run(log, "supabase", ["status", "-o", "json", "--workdir", gateWorkdir], { quiet: true });
      let gateEnv = null;
      if (status.code !== 0) fail(`supabase status exited ${status.code}`);
      else {
        try {
          gateEnv = gateEnvFromStatus(status.stdout);
          log.step(`gate endpoints: API ${gateEnv.SUPABASE_GATE_URL}, database port ${new URL(gateEnv.SUPABASE_GATE_DB_URL).port}`);
        } catch (error) {
          fail(error.message);
        }
      }
      if (gateEnv && !runFailure) {
        fs.rmSync(path.join(root, VITEST_REPORT), { force: true });
        const vitest = await run(
          log,
          "pnpm",
          ["exec", "vitest", "run", "--project", "db", "--reporter=default", "--reporter=json", `--outputFile.json=${VITEST_REPORT}`],
          { env: { ...process.env, ...gateEnv }, tee: true },
        );
        if (vitest.code !== 0) fail(`vitest db project exited ${vitest.code}`);
        else log.step("vitest db project passed");
      }
    }
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    identityFailure = error.message;
  }

  // 6. verify identity again, stop, verify removal, delete receipt, release lock
  log.step("step 6: verify identity before disposal");
  if (identityFailure) {
    if (!runFailure) runFailure = identityFailure;
    cleanupFailure = `not disposed: ${identityFailure}`;
  } else {
    try {
      const nowCtx = await dockerContext(log);
      if (!sameContext(nowCtx, context)) throw new Refusal(`Docker context changed from ${context.name} to ${nowCtx.name}`);
      const inv = await inventory(log);
      const problems = [...labelProblems(inv, gateWorkdir), ...identityProblems(recorded ?? { containers: [], volumes: [], networks: [] }, inv)];
      if (problems.length > 0) throw new Refusal(`identity changed since step 5:\n  - ${problems.join("\n  - ")}`);
      log.step("identity unchanged: same container, volume and network identities as recorded");
      cleanupFailure = await dispose(log, gateWorkdir);
      if (!cleanupFailure) {
        fs.rmSync(receiptFile);
        log.step(`receipt deleted: ${receiptFile}`);
        log.marker(GATE_DB_TEARDOWN_MARKER);
      }
    } catch (error) {
      if (!(error instanceof Refusal)) throw error;
      cleanupFailure = `not disposed: ${error.message}`;
    }
  }
  if (cleanupFailure) {
    log.problem(`cleanup failure: ${cleanupFailure}`);
    log.problem(`left in place with receipt ${receiptFile}; inspect, then run pnpm gate-db:recover or remove it with its owner`);
  }
  releaseLock(lockFile, runId);
  log.step("lock released");
  process.off("SIGINT", onSignal);
  process.off("SIGTERM", onSignal);
  return finish(log, runFailure, cleanupFailure);
}

function finish(log, runFailure, cleanupFailure) {
  if (runFailure) log.problem(`first failure: ${runFailure}`);
  if (cleanupFailure) log.problem(`cleanup failure: ${cleanupFailure.split("\n")[0]}`);
  const code = (runFailure ? EXIT.runFailed : 0) | (cleanupFailure ? EXIT.cleanupFailed : 0);
  log.step(`result: exit ${code}`);
  return code;
}

// ---------------------------------------------------------------- recover

async function recover({ root, coordDir }) {
  const lockFile = path.join(coordDir, "lock");
  const receiptFile = path.join(coordDir, "receipt.json");
  const runId = randomBytes(8).toString("hex");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const log = createLog(path.join(root, ".local", "gate-db", `recover-${stamp}.log`));
  log.step(`gate-db recover ${runId}: pid ${process.pid}, coordination ${coordDir}`);

  const receipt = readJson(receiptFile);
  const lock = readJson(lockFile);
  if (!receipt) {
    if (lock && !isAlive(lock.pid)) {
      log.problem(`no receipt, but ${lockFile} is held by dead ${holderText(lock)}; the run stopped before it wrote a receipt. Check for retrofit-gate resources, then remove the lock file.`);
      return EXIT.refused;
    }
    log.step("nothing to recover: no receipt");
    return EXIT.ok;
  }
  if (isAlive(receipt.pid)) {
    log.problem(`receipt run pid ${receipt.pid} is alive (worktree ${receipt.worktree}, started ${receipt.startedAt}); leaving everything in place`);
    return EXIT.refused;
  }
  if (lock && lock.pid !== receipt.pid && isAlive(lock.pid)) {
    log.problem(`${lockFile} is held by live ${holderText(lock)}; leaving everything in place`);
    return EXIT.refused;
  }

  // Take over a stale lock atomically: only one recover can rename it.
  const staleCopy = `${lockFile}.stale-${process.pid}`;
  if (lock) {
    try {
      fs.renameSync(lockFile, staleCopy);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      log.problem("the lock changed during recovery; leaving everything in place");
      return EXIT.refused;
    }
  }
  const held = acquireLock(lockFile, { runId, pid: process.pid, worktree: root, startedAt: new Date().toISOString(), recovering: receipt.runId });
  if (held) {
    log.problem(`${lockFile} was taken by ${holderText(held)} during recovery; leaving everything in place`);
    return EXIT.refused;
  }
  const done = (code) => {
    releaseLock(lockFile, runId);
    fs.rmSync(staleCopy, { force: true });
    log.step(`lock released; result: exit ${code}`);
    return code;
  };
  // A refusal leaves the receipt and puts the dead holder's lock back in place, so nothing changes.
  const refuse = (message) => {
    log.problem(message);
    releaseLock(lockFile, runId);
    if (lock && fs.existsSync(staleCopy)) fs.renameSync(staleCopy, lockFile);
    log.step("everything left in place; result: exit 1");
    return EXIT.refused;
  };

  log.step(`receipt from dead run ${holderText(receipt)}`);
  let inv;
  try {
    const context = await dockerContext(log);
    if (!sameContext(context, receipt.context)) {
      return refuse(`Docker context ${context.name} (${context.host}) is not the receipt context ${receipt.context?.name} (${receipt.context?.host})`);
    }
    inv = await inventory(log);
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    return refuse(error.message);
  }

  const problems = labelProblems(inv, receipt.gateWorkdir);
  if (receipt.resources) {
    problems.push(...identityProblems(receipt.resources, inv, { allowMissing: true }));
  } else {
    // Interrupted before identities were recorded: accept only resources created after the
    // receipt (the dead run held the lock from before then).
    const since = Date.parse(receipt.startedAt);
    for (const r of [...inv.containers, ...inv.volumes, ...inv.networks]) {
      if (!(Date.parse(r.created) >= since)) problems.push(`${r.name} was created before the receipt (${r.created})`);
    }
  }
  if (problems.length > 0) {
    return refuse(`the retrofit-gate stack does not match the receipt:\n  - ${problems.join("\n  - ")}\n${describeInventory(inv)}`);
  }

  if (inv.count === 0) {
    log.step("no retrofit-gate resources remain");
  } else {
    log.step(`every resource matches the receipt:\n${describeInventory(inv)}`);
    if (!fs.existsSync(path.join(receipt.gateWorkdir, "supabase", "config.toml"))) {
      return refuse(`${receipt.gateWorkdir}/supabase/config.toml is missing; the stack cannot be stopped from its own workdir`);
    }
    const failure = await dispose(log, receipt.gateWorkdir);
    if (failure) {
      log.problem(`cleanup failure: ${failure}`);
      return done(EXIT.cleanupFailed);
    }
  }
  fs.rmSync(receiptFile);
  log.step(`receipt deleted: ${receiptFile}`);
  log.marker("GATE-DB RECOVER COMPLETE");
  return done(EXIT.ok);
}

// ---------------------------------------------------------------- main

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    process.stderr.write(`gate-db: ${error.message}\n`);
    return EXIT.usage;
  }
  return options.command === "recover" ? recover(options) : runGateDb(options);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
