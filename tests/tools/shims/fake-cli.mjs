// Process-boundary stand-ins for the `docker`, `supabase` and `pnpm` executables used by
// tools/gate-db.mjs. tests/tools/gate-db.test.ts puts small sh wrappers on PATH that run
//   node fake-cli.mjs <docker|supabase|pnpm> ...args
// The fake machine state (containers, volumes, networks, Docker context) and the scenario live in
// the JSON file named by FAKE_CLI_STATE; every call is appended as one JSON line to FAKE_CLI_CALLS.
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const LABEL_PROJECT = "com.supabase.cli.project";
const LABEL_WORKDIR = "com.supabase.cli.workdir";

const [tool, ...args] = process.argv.slice(2);
const statePath = process.env.FAKE_CLI_STATE;
const callsPath = process.env.FAKE_CLI_CALLS;
if (!statePath || !callsPath) {
  process.stderr.write("fake-cli: FAKE_CLI_STATE and FAKE_CLI_CALLS are required\n");
  process.exit(90);
}

const readState = () => JSON.parse(fs.readFileSync(statePath, "utf8"));
function writeState(state) {
  const tmp = `${statePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, statePath);
}
const newId = () => randomBytes(32).toString("hex");
const now = () => new Date().toISOString();

fs.appendFileSync(
  callsPath,
  `${JSON.stringify({
    tool,
    args,
    ppid: process.ppid,
    gateEnv: Boolean(process.env.SUPABASE_GATE_URL && process.env.SUPABASE_GATE_SERVICE_ROLE_KEY && process.env.SUPABASE_GATE_DB_URL),
    mailEnv: process.env.SUPABASE_GATE_MAIL_URL ?? null,
    anonEnv: Boolean(process.env.SUPABASE_GATE_ANON_KEY),
  })}\n`,
);

const out = (text) => process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
const fail = (code, message) => {
  process.stderr.write(`${message}\n`);
  process.exit(code);
};
const flag = (name) => {
  const i = args.indexOf(name);
  if (i >= 0) return args[i + 1];
  const prefixed = args.find((a) => a.startsWith(`${name}=`));
  return prefixed ? prefixed.slice(name.length + 1) : undefined;
};

function matches(resource, filters) {
  return filters.every((f) => {
    if (f.startsWith("label=")) {
      const [key, value] = f.slice(6).split(/=(.*)/s);
      return resource.labels?.[key] === value;
    }
    if (f.startsWith("name=")) return resource.name.includes(f.slice(5));
    // Containers only: the volumes they mount and the networks they are attached to (name or id).
    if (f.startsWith("volume=")) return (resource.mounts ?? []).includes(f.slice(7));
    if (f.startsWith("network=")) return (resource.networks ?? []).includes(f.slice(8));
    return false;
  });
}
const filtersOf = () => args.flatMap((a, i) => (a === "--filter" ? [args[i + 1]] : []));

function docker() {
  const state = readState();
  const scenario = state.scenario ?? {};
  const sub = args[0] === "volume" || args[0] === "network" || args[0] === "context" ? `${args[0]} ${args[1]}` : args[0];
  if (scenario.dockerFail === sub) fail(1, `Cannot connect to the Docker daemon (fake failure on ${sub})`);
  switch (sub) {
    case "context show":
      // Simulates another process writing the lock while the tool waits on Docker.
      if (scenario.writeLockOnContextShow) {
        fs.writeFileSync(scenario.writeLockOnContextShow.path, scenario.writeLockOnContextShow.content);
      }
      return out(state.context);
    case "context inspect":
      if (scenario.contextInspectGarbage) return out("this is not JSON");
      return out(JSON.stringify([{ Name: args[2], Endpoints: { docker: { Host: state.contextHost } } }]));
    case "ps":
      return out(state.containers.filter((c) => matches(c, filtersOf())).map((c) => c.id).join("\n"));
    case "volume ls":
      return out(state.volumes.filter((v) => matches(v, filtersOf())).map((v) => v.name).join("\n"));
    case "network ls":
      return out(state.networks.filter((n) => matches(n, filtersOf())).map((n) => n.id).join("\n"));
    case "inspect": {
      const ids = args.slice(args.indexOf("container") + 1);
      const found = ids.map((id) => state.containers.find((c) => c.id === id));
      if (found.some((c) => !c)) fail(1, "Error: No such container");
      return out(JSON.stringify(found.map((c) => ({ Id: c.id, Name: `/${c.name}`, Created: c.created, Config: { Labels: c.labels } }))));
    }
    case "volume inspect": {
      const found = args.slice(2).map((name) => state.volumes.find((v) => v.name === name));
      if (found.some((v) => !v)) fail(1, "Error: No such volume");
      return out(JSON.stringify(found.map((v) => ({ Name: v.name, CreatedAt: v.created, Labels: v.labels }))));
    }
    case "network inspect": {
      const found = args.slice(2).map((id) => state.networks.find((n) => n.id === id));
      if (found.some((n) => !n)) fail(1, "Error: No such network");
      // Like Docker, Containers lists the containers attached to the network (by id or name).
      const attached = (n) =>
        Object.fromEntries(state.containers.filter((c) => (c.networks ?? []).some((x) => x === n.id || x === n.name)).map((c) => [c.id, { Name: c.name }]));
      return out(JSON.stringify(found.map((n) => ({ Id: n.id, Name: n.name, Created: n.created, Labels: n.labels, Containers: attached(n) }))));
    }
    default:
      fail(91, `fake docker: unsupported command ${args.join(" ")}`);
  }
}

function configOf(workdir) {
  const toml = fs.readFileSync(path.join(workdir, "supabase", "config.toml"), "utf8");
  const project = /^project_id\s*=\s*"([^"]+)"/m.exec(toml)?.[1];
  const apiPort = /\[api\][^[]*?\bport\s*=\s*(\d+)/s.exec(toml)?.[1];
  const dbPort = /\[db\][^[]*?\bport\s*=\s*(\d+)/s.exec(toml)?.[1];
  const mailPort = /\[local_smtp\][^[]*?\bport\s*=\s*(\d+)/s.exec(toml)?.[1];
  return { project, apiPort, dbPort, mailPort };
}

function supabase() {
  const state = readState();
  const scenario = state.scenario ?? {};
  const workdir = flag("--workdir");
  const command = args[0] === "db" ? `db ${args[1]}` : args[0];
  switch (command) {
    case "start": {
      const { project } = configOf(workdir);
      if (state.containers.some((c) => c.labels[LABEL_PROJECT] === project)) fail(1, "supabase start is already running.");
      const labels = { [LABEL_PROJECT]: project, [LABEL_WORKDIR]: workdir, "com.docker.compose.project": project };
      const volume = `supabase_db_${project}`;
      const network = `supabase_network_${project}`;
      for (const service of ["db", "rest", "kong"]) {
        state.containers.push({ id: newId(), name: `supabase_${service}_${project}`, labels: { ...labels }, created: now(), mounts: service === "db" ? [volume] : [], networks: [network] });
      }
      state.volumes.push({ name: volume, labels: { [LABEL_PROJECT]: project }, created: now() });
      state.networks.push({ id: newId(), name: network, labels: { [LABEL_PROJECT]: project }, created: now() });
      // Another project's container that starts using the gate stack's volume or network.
      if (scenario.startAddsConsumer) state.containers.push({ id: newId(), created: now(), labels: {}, ...scenario.startAddsConsumer });
      writeState(state);
      out("Started supabase local development setup.\nservice_role key: eyJhbGciOiJIUzI1NiJ9.e30.fake-signature");
      return process.exit(scenario.startExit ?? 0);
    }
    case "db reset": {
      if (scenario.resetExit) fail(scenario.resetExit, "fake reset failure");
      const { project } = configOf(workdir);
      // Like the real CLI, a local reset recreates the database container.
      const db = state.containers.find((c) => c.name === `supabase_db_${project}`);
      if (db) db.id = newId();
      writeState(state);
      return out("Finished supabase db reset on branch main.");
    }
    case "status": {
      const { project, apiPort, dbPort, mailPort } = configOf(workdir);
      if (!state.containers.some((c) => c.labels[LABEL_PROJECT] === project)) fail(1, `${project} is not running.`);
      // Like CLI 3.x: the mail catcher (Mailpit) URL only when [local_smtp] is configured.
      const mail = scenario.statusMailPort ?? mailPort;
      return out(
        JSON.stringify({
          API_URL: `http://127.0.0.1:${apiPort}`,
          DB_URL: `postgresql://postgres:postgres@127.0.0.1:${dbPort}/postgres`,
          SERVICE_ROLE_KEY: "eyJhbGciOiJIUzI1NiJ9.e30.fake-service-role",
          ANON_KEY: "eyJhbGciOiJIUzI1NiJ9.e30.fake-anon",
          ...(mail ? { MAILPIT_URL: `http://127.0.0.1:${mail}` } : {}),
        }),
      );
    }
    case "stop": {
      if (args.includes("--all")) fail(92, "fake supabase: --all is never allowed");
      const project = flag("--project-id") ?? configOf(workdir).project;
      if (scenario.stopExit) fail(scenario.stopExit, "fake stop failure");
      const leaves = scenario.stopLeaves ?? [];
      const keep = (r) => r.labels?.[LABEL_PROJECT] !== project;
      state.containers = state.containers.filter(keep);
      if (args.includes("--no-backup") && !leaves.includes("volume")) state.volumes = state.volumes.filter(keep);
      state.networks = state.networks.filter(keep);
      writeState(state);
      return out(`Stopped supabase local development setup for ${project}.`);
    }
    default:
      fail(93, `fake supabase: unsupported command ${args.join(" ")}`);
  }
}

async function pnpm() {
  const state = readState();
  const scenario = state.scenario ?? {};
  if (args[0] !== "exec" || args[1] !== "vitest") fail(94, `fake pnpm: unsupported command ${args.join(" ")}`);
  if (scenario.vitestWaitFor) {
    const deadline = Date.now() + 30_000;
    while (!fs.existsSync(scenario.vitestWaitFor)) {
      if (Date.now() > deadline) fail(95, "fake pnpm: timed out waiting");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  if (scenario.vitestAddsConsumer) {
    state.containers.push({ id: newId(), created: now(), labels: {}, ...scenario.vitestAddsConsumer });
    writeState(state);
  }
  if (scenario.vitestReplaceContainer) {
    const target = state.containers.find((c) => c.name === scenario.vitestReplaceContainer);
    if (target) target.id = newId();
    writeState(state);
  }
  if (scenario.vitestKillParent) {
    process.kill(process.ppid, "SIGKILL");
    return process.exit(137);
  }
  const output = flag("--outputFile.json");
  if (output) {
    // The shape of Vitest's JSON reporter that tools/release/analyze-evidence.mjs reads.
    const status = scenario.vitestExit ? "failed" : "passed";
    const report = scenario.vitestReportMinimal
      ? { success: true }
      : {
          success: !scenario.vitestExit,
          numPassedTests: scenario.vitestExit ? 0 : 1,
          numTotalTests: 1,
          testResults: [{ name: "tests/db/store.test.ts", status, assertionResults: [{ fullName: "fake db test", status }] }],
        };
    fs.writeFileSync(output, JSON.stringify(report));
  }
  out(scenario.vitestExit ? " FAIL  tests/db/store.test.ts" : " PASS  tests/db/store.test.ts");
  process.exit(scenario.vitestExit ?? 0);
}

if (tool === "docker") docker();
else if (tool === "supabase") supabase();
else if (tool === "pnpm") await pnpm();
else fail(96, `fake-cli: unknown tool ${tool}`);
