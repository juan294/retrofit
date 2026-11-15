#!/usr/bin/env node
// Collects the production evidence for one candidate deployment (phase-7.md, "Production
// evidence (step 12)") into .local/evidence/production/<deployment id>/, in the shape that
// analyze-evidence.mjs --production reads.
//
//   node tools/release/production-evidence.mjs <deployment-id> <deployment-url> <commit>
//        [--created-at <ISO time>] [--dry-run] [--fresh] [--skip-playwright] [--evidence-dir <dir>]
//
// Each run writes run.json with a new random run id and stamps every case report with it; the
// analyzer rejects a report from another run. It refuses to start when the evidence directory
// already holds files; --fresh first moves them to <dir>.previous-<time>.
//
// It contacts production: Vercel (inspect, list), the deployment's API, the organizers'
// partner check and a Playwright run against the live pages.
//
// Identity: `vercel inspect` names the deployment that the deployment URL and each alias of the
// binding case (the production host and the peer host) serve, before the first case and again
// after the last. A host bound to another deployment, or one Vercel cannot inspect, fails the
// alias-binding case; when that happens before the suites, no suite runs (fail closed). Run it only as the integration
// owner, after an authorized candidate deployment (phase-7.md, External actions, step 12).
// --dry-run prints every command and URL and contacts nothing.
//
// Exit 0: every case passed. Exit 1: a case failed or is missing (reports are still written).
// Exit 2: usage error, earlier evidence without --fresh, or no deployment creation time.
// The release decision is analyze-evidence.mjs <commit> --production <dir>, not this exit code.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { DEPLOYMENT_ID, caseReport, prodUrl, writeCaseFile } from "../../e2e-prod/support/case-report.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const VERCEL_SCOPE = "thecreativetoken";
export const VERCEL_PROJECT = "retrofit";
export const PLAYWRIGHT_ARGV = ["exec", "playwright", "test", "--config", "e2e-prod/playwright.config.ts"];
/** Retrofit's own pages for the five concurrent analyses (each analysis reads the site from its origin). */
export const OWN_PAGES = ["/", "/conformance", "/bot", "/judges", "/?evidence=concurrency"];
const CHECK_PARTNER = "tools/agentic-web/scripts/check_partner.mjs";
const HTTP_TIMEOUT_MS = 30_000;
const ANALYSIS_DEADLINE_MS = 180_000;
const POLL_MS = 2_000;
const USAGE =
  "usage: production-evidence.mjs <deployment-id> <deployment-url> <commit> " +
  "[--created-at <ISO time>] [--dry-run] [--fresh] [--skip-playwright] [--evidence-dir <dir>]";

class UsageError extends Error {}

function parseArgs(argv) {
  const o = { dryRun: false, fresh: false, skipPlaywright: false, createdAt: null, evidenceDir: null, positional: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) throw new UsageError(`${arg} needs a value\n${USAGE}`);
      return argv[++i];
    };
    if (arg === "--dry-run") o.dryRun = true;
    else if (arg === "--fresh") o.fresh = true;
    else if (arg === "--skip-playwright") o.skipPlaywright = true;
    else if (arg === "--created-at") o.createdAt = value();
    else if (arg === "--evidence-dir") o.evidenceDir = value();
    else if (arg.startsWith("--")) throw new UsageError(`unknown argument: ${arg}\n${USAGE}`);
    else o.positional.push(arg);
  }
  const [deploymentId, deploymentUrl, commit, ...rest] = o.positional;
  if (!commit || rest.length > 0) throw new UsageError(USAGE);
  if (!DEPLOYMENT_ID.test(deploymentId)) throw new UsageError(`deployment id ${deploymentId} is not a Vercel deployment id (dpl_...)`);
  let url;
  try {
    url = new URL(deploymentUrl);
  } catch {
    throw new UsageError(`deployment URL ${deploymentUrl} is not a URL`);
  }
  if (url.protocol !== "https:") throw new UsageError(`deployment URL ${deploymentUrl} must use https`);
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new UsageError(`commit ${commit} must be the full 40-character merge commit`);
  if (o.createdAt !== null && !Number.isFinite(Date.parse(o.createdAt))) throw new UsageError(`--created-at ${o.createdAt} is not a time`);
  const prod = prodUrl();
  const evidenceRoot = path.resolve(ROOT, o.evidenceDir ?? path.join(".local", "evidence", "production"));
  return { ...o, deploymentId, deploymentUrl: deploymentUrl.replace(/\/+$/, ""), commit, prod, evidenceRoot, dir: path.join(evidenceRoot, deploymentId) };
}

function requiredCases() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, "tools", "release", "required-production-cases.json"), "utf8")).cases;
}

/** The case ids the e2e-prod specs declare with evidence.case("<id>"). */
export function playwrightCases() {
  const dir = path.join(ROOT, "e2e-prod");
  const ids = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".spec.ts"))
    .sort()
    .flatMap((name) => [...fs.readFileSync(path.join(dir, name), "utf8").matchAll(/evidence\.case\("([a-z0-9-]+)"\)/g)].map((m) => m[1]));
  return [...new Set(ids)];
}

const ms = (start) => Math.round(performance.now() - start);

async function http(method, url, init = {}) {
  const start = performance.now();
  try {
    const res = await fetch(url, { method, cache: "no-store", redirect: "manual", signal: AbortSignal.timeout(HTTP_TIMEOUT_MS), ...init });
    const text = await res.text().catch(() => "");
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // Not JSON: callers treat it as a failed probe.
    }
    return { status: res.status, ms: ms(start), json, headers: res.headers };
  } catch (error) {
    return { status: 0, ms: ms(start), json: null, headers: { get: () => null, getSetCookie: () => [] }, error: error instanceof Error ? error.name : "error" };
  }
}

function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, { cwd: ROOT, encoding: "utf8", timeout: 180_000, ...options });
  return {
    status: typeof result?.status === "number" ? result.status : -1,
    stdout: result?.stdout ?? "",
    stderr: result?.stderr ?? "",
    output: `${result?.stdout ?? ""}${result?.stderr ?? ""}`,
    signal: result?.signal ?? null,
    error: result?.error ? result.error.message : null,
  };
}

const stats = (values) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return { min: sorted[0], median: sorted[Math.floor(sorted.length / 2)], max: sorted[sorted.length - 1] };
};

async function oneAnalysis(o, pagePath) {
  const url = `${o.prod}${pagePath}`;
  const start = performance.now();
  const post = await http("POST", `${o.prod}/api/analyze`, {
    headers: { origin: o.prod, "content-type": "application/json" },
    body: JSON.stringify({ url }),
  });
  const id = typeof post.json?.id === "string" ? post.json.id : null;
  const setCookies = typeof post.headers.getSetCookie === "function" ? post.headers.getSetCookie() : [post.headers.get("set-cookie") ?? ""];
  const cookie = setCookies.map((c) => c.split(";")[0].trim()).filter(Boolean).join("; ");
  const result = { url, postStatus: post.status, postMs: post.ms, id, polls: 0, statusLatencyMs: null, finalStatus: null, scoreReady: false, readyAfterMs: null };
  if (post.status !== 200 || !id) return { ...result, finalStatus: "not-started", error: post.json?.error ?? post.error ?? null };
  const latencies = [];
  const deadline = performance.now() + ANALYSIS_DEADLINE_MS;
  for (;;) {
    const poll = await http("GET", `${o.prod}/api/analyze/${id}`, { headers: { cookie } });
    latencies.push(poll.ms);
    result.polls += 1;
    result.finalStatus = poll.status === 200 ? (poll.json?.status ?? "unreadable") : `http-${poll.status}`;
    result.scoreReady = poll.json?.scoreReady === true;
    if (["ready", "failed", "expired"].includes(result.finalStatus) || poll.status >= 400 || performance.now() > deadline) break;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  result.statusLatencyMs = stats(latencies);
  if (result.finalStatus === "ready") result.readyAfterMs = ms(start);
  return result;
}

/** The ordered steps: what each produces and every command and URL it uses. */
function steps(o, cases, pwCases) {
  const partners = cases.filter((c) => c.kind === "partner");
  const inspectShow = identityTargets(o, cases).map((t) => `$ vercel inspect ${t} --format json --scope ${VERCEL_SCOPE}`);
  const env = [
    `RETROFIT_PROD_URL=${o.prod}`,
    `RETROFIT_DEPLOYMENT_ID=${o.deploymentId}`,
    `RETROFIT_DEPLOYMENT_URL=${o.deploymentUrl}`,
    `RETROFIT_EVIDENCE_DIR=${o.evidenceRoot}`,
    "RETROFIT_RUN_ID=<this run's id>",
    "JUDGE_CODE=<from the environment, not printed>",
  ];
  return [
    {
      name: "deployment-record",
      produces: ["deployment.json"],
      show: [`$ vercel inspect ${o.deploymentUrl} --format json --scope ${VERCEL_SCOPE}`, `  fallback for createdAt: --created-at ${o.createdAt ?? "<required when vercel inspect gives no creation time>"}`],
      run: recordDeployment,
    },
    {
      name: "alias-identity",
      produces: [],
      show: [...inspectShow, `  each must name ${o.deploymentId}; otherwise alias-binding fails and no suite runs`],
      run: aliasIdentityBefore,
    },
    { name: "version", produces: ["version-commit"], show: [`GET ${o.prod}/api/version`], run: checkVersion },
    { name: "health", produces: ["health-ok"], show: [`GET ${o.prod}/api/health`], run: checkHealth },
    {
      name: "partners",
      produces: partners.map((c) => c.id),
      show: partners.map((c) => `$ ${process.execPath} ${CHECK_PARTNER} ${c.target}`),
      run: (ctx) => checkPartners(ctx, partners),
    },
    {
      name: "concurrent-analyses",
      produces: ["concurrent-analyses-five"],
      show: [
        `POST ${o.prod}/api/analyze x5 (concurrent): ${OWN_PAGES.map((p) => `${o.prod}${p}`).join(", ")}`,
        `GET ${o.prod}/api/analyze/<id> for each, every ${POLL_MS / 1000} s until ready, at most ${ANALYSIS_DEADLINE_MS / 1000} s`,
      ],
      run: concurrentAnalyses,
    },
    {
      name: "no-preview-deployments",
      produces: ["no-preview-deployments"],
      show: [`$ vercel list ${VERCEL_PROJECT} --environment preview --scope ${VERCEL_SCOPE}`],
      run: noPreviewDeployments,
    },
    {
      name: "playwright",
      produces: pwCases,
      show: [
        `$ ${env.join(" ")} pnpm ${PLAYWRIGHT_ARGV.join(" ")}`,
        `  browser contacts ${o.prod} and https://demo-harbor.thecreativetoken.com; the BYOK router https://api.otari.ai is answered inside the browser`,
        "  @real-model cases (free-path-real-model-smoke, analyze-own-site) make real model calls on Retrofit's free path; every other case scripts the model",
        ...(o.skipPlaywright ? ["  skipped (--skip-playwright): its cases will be missing"] : []),
      ],
      run: (ctx) => runPlaywright(ctx, pwCases),
    },
    {
      name: "alias-binding",
      produces: ["alias-binding"],
      show: [
        `GET ${o.deploymentUrl}/api/version`,
        `GET ${o.prod}/api/version`,
        "  both must return the candidate commit",
        ...inspectShow,
        `  again after the suites: each must still name ${o.deploymentId}`,
      ],
      run: checkAliasBinding,
    },
  ];
}

/**
 * Vercel's record of the deployment that `target` (a deployment URL or an alias) serves:
 * `vercel inspect <target> --format json`. The authoritative alias-to-deployment source.
 * The record is read from stdout only: the CLI writes its banner and, without a TTY, a
 * "Fetching deployment" line to stderr on every call. `detail` explains a failed call.
 *
 * @returns {{status: number, info: Record<string, unknown> | null, detail: string}}
 */
export function vercelInspect(target) {
  // NO_UPDATE_NOTIFIER: the CLI's update box would otherwise be the last stderr line.
  const r = run("vercel", ["inspect", target, "--format", "json", "--scope", VERCEL_SCOPE], { timeout: 60_000, env: { ...process.env, NO_UPDATE_NOTIFIER: "1" } });
  let info = null;
  if (r.status === 0) {
    try {
      const parsed = JSON.parse(r.stdout);
      info = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
    } catch {
      // Not JSON: no record.
    }
  }
  // The spawn error when the CLI could not run, else the CLI's last error line, else its last line.
  const lines = r.stderr.split("\n").map((l) => l.trim()).filter(Boolean);
  const detail = r.error ?? lines.filter((l) => /\bError\b/.test(l)).at(-1) ?? lines.at(-1) ?? "";
  return { status: r.status, info, detail };
}

/** The targets whose deployment the identity checks: the deployment URL, the production host and the binding case's aliases. */
function identityTargets(o, cases) {
  const aliases = cases.find((c) => c.kind === "binding")?.aliases ?? [];
  const hosts = [new URL(o.prod).host, ...aliases].filter((h, i, all) => all.indexOf(h) === i);
  return [o.deploymentUrl, ...hosts.map((h) => `https://${h}`)];
}

/** One identity check: {checkedAt, deployments: {host: deployment id or "unavailable (...)"}}. */
function inspectIdentity(ctx) {
  const deployments = {};
  for (const target of identityTargets(ctx.o, ctx.cases)) {
    const r = ctx.inspect(target);
    const id = typeof r.info?.id === "string" && r.info.id ? r.info.id : null;
    const why = r.status === 0 ? "no deployment record on stdout" : (r.detail ?? "");
    deployments[new URL(target).host] = id ?? `unavailable (exit ${r.status}${why ? `: ${why.slice(0, 120)}` : ""})`;
  }
  return { checkedAt: new Date().toISOString(), deployments };
}

/** What is wrong with one identity check, as visitor-readable lines; empty when every host serves the candidate. */
function identityProblems(o, check) {
  return Object.entries(check.deployments).flatMap(([host, id]) => {
    if (id.startsWith("unavailable")) return [`alias identity could not be inspected: ${host} ${id}`];
    return id === o.deploymentId ? [] : [`${host} is bound to ${id}, not ${o.deploymentId}`];
  });
}

function aliasIdentityBefore(ctx) {
  ctx.identityBefore = inspectIdentity(ctx);
  const problems = identityProblems(ctx.o, ctx.identityBefore);
  if (problems.length === 0) {
    ctx.say(`  every host serves ${ctx.o.deploymentId}`);
    return;
  }
  for (const p of problems) ctx.say(`  ${p}`);
  record(ctx, "alias-binding", false, { alias: ctx.o.prod, identity: { source: "vercel inspect", before: ctx.identityBefore, after: null }, problems });
  ctx.say("  stopping: no suite runs against hosts that do not serve the candidate deployment");
  ctx.stop = true;
}

function record(ctx, caseId, passed, extra = {}) {
  const report = caseReport({
    caseId,
    status: passed ? "passed" : "failed",
    deploymentId: ctx.o.deploymentId,
    deploymentUrl: ctx.o.deploymentUrl,
    commit: ctx.served,
    runId: ctx.runId,
    extra,
  });
  writeCaseFile(ctx.o.evidenceRoot, report);
  ctx.results.set(caseId, passed);
  ctx.say(`  ${passed ? "passed" : "FAILED"} ${caseId}`);
}

function writeLog(ctx, name, text) {
  fs.writeFileSync(path.join(ctx.o.dir, name), text);
  return name;
}

function recordDeployment(ctx) {
  const { o } = ctx;
  const inspect = ctx.inspect(o.deploymentUrl);
  let createdAt = null;
  let source = null;
  if (inspect.status === 0) {
    const info = inspect.info;
    // Fail closed: a successful inspection must give a record whose id and target can be checked.
    if (typeof info?.id !== "string" || !info.id) throw new UsageError(`vercel inspect exited 0 but gave no deployment record for ${o.deploymentUrl}`);
    if (info.id !== o.deploymentId) throw new UsageError(`vercel inspect reports deployment ${info.id}, not ${o.deploymentId}`);
    if (info.target && info.target !== "production") throw new UsageError(`vercel inspect reports target ${info.target}, not production`);
    const raw = info.createdAt ?? info.created;
    const t = typeof raw === "number" ? raw : Date.parse(raw);
    if (Number.isFinite(t)) {
      createdAt = new Date(t).toISOString();
      source = "vercel inspect";
    }
  }
  if (createdAt === null && o.createdAt !== null) {
    createdAt = new Date(o.createdAt).toISOString();
    source = "--created-at";
  }
  if (createdAt === null) {
    throw new UsageError(`vercel inspect gave no creation time (exit ${inspect.status}); pass --created-at <ISO time> from the deployment record`);
  }
  if (source === "vercel inspect" && o.createdAt !== null && Date.parse(o.createdAt) !== Date.parse(createdAt)) {
    ctx.say(`  note: --created-at ${o.createdAt} ignored; vercel inspect gives ${createdAt}`);
  }
  fs.mkdirSync(o.dir, { recursive: true });
  fs.writeFileSync(path.join(o.dir, "run.json"), `${JSON.stringify({ runId: ctx.runId, startedAt: ctx.startedAt, deploymentId: o.deploymentId, commit: o.commit }, null, 2)}\n`);
  ctx.say(`  run.json runId ${ctx.runId}`);
  const deployment = { deploymentId: o.deploymentId, deploymentUrl: o.deploymentUrl, createdAt, commit: o.commit, createdAtSource: source };
  fs.writeFileSync(path.join(o.dir, "deployment.json"), `${JSON.stringify(deployment, null, 2)}\n`);
  ctx.say(`  deployment.json createdAt ${createdAt} (${source})`);
}

/** The commit an /api/version response names, or "unavailable (status <n>)". */
const commitOf = (res) => (typeof res.json?.commit === "string" && res.json.commit ? res.json.commit : `unavailable (status ${res.status})`);

async function checkVersion(ctx) {
  const res = await http("GET", `${ctx.o.prod}/api/version`);
  const served = commitOf(res);
  ctx.served = served;
  record(ctx, "version-commit", res.status === 200 && served === ctx.o.commit, { httpStatus: res.status, ms: res.ms, served, expected: ctx.o.commit });
}

async function checkAliasBinding(ctx) {
  const [deployment, alias] = await Promise.all([http("GET", `${ctx.o.deploymentUrl}/api/version`), http("GET", `${ctx.o.prod}/api/version`)]);
  const deploymentCommit = commitOf(deployment);
  const aliasCommit = commitOf(alias);
  const after = inspectIdentity(ctx);
  const problems = [...identityProblems(ctx.o, ctx.identityBefore).map((p) => `before: ${p}`), ...identityProblems(ctx.o, after).map((p) => `after: ${p}`)];
  for (const p of problems) ctx.say(`  ${p}`);
  record(ctx, "alias-binding", deploymentCommit === ctx.o.commit && aliasCommit === ctx.o.commit && problems.length === 0, {
    alias: ctx.o.prod,
    deploymentCommit,
    aliasCommit,
    expected: ctx.o.commit,
    deploymentStatus: deployment.status,
    aliasStatus: alias.status,
    identity: { source: "vercel inspect", before: ctx.identityBefore, after },
    problems,
  });
}

async function checkHealth(ctx) {
  const res = await http("GET", `${ctx.o.prod}/api/health`);
  record(ctx, "health-ok", res.status === 200 && res.json?.status === "ok", { httpStatus: res.status, ms: res.ms, body: res.json?.status ?? null });
}

function checkPartners(ctx, partners) {
  for (const c of partners) {
    const r = run(process.execPath, [CHECK_PARTNER, c.target], { timeout: 120_000 });
    const errorLines = r.output.split("\n").filter((line) => /^\s*(ERROR\b|FAILED\b)/.test(line));
    const log = writeLog(ctx, `${c.id}.log`, `$ node ${CHECK_PARTNER} ${c.target}\nexit ${r.status} signal ${r.signal ?? "none"}${r.error ? ` error ${r.error}` : ""}\n${r.output}`);
    record(ctx, c.id, r.status === 0 && errorLines.length === 0 && r.output.trim().length > 0, { target: c.target, exitCode: r.status, errorLines, log });
  }
}

async function concurrentAnalyses(ctx) {
  const start = performance.now();
  const analyses = await Promise.all(OWN_PAGES.map((p) => oneAnalysis(ctx.o, p)));
  const passed = analyses.every((a) => a.finalStatus === "ready" && a.scoreReady);
  record(ctx, "concurrent-analyses-five", passed, {
    wallMs: ms(start),
    readyAfterMs: stats(analyses.map((a) => a.readyAfterMs).filter((v) => typeof v === "number")),
    statusLatencyMedianMs: stats(analyses.map((a) => a.statusLatencyMs?.median).filter((v) => typeof v === "number")),
    analyses,
  });
}

function noPreviewDeployments(ctx) {
  const r = run("vercel", ["list", VERCEL_PROJECT, "--environment", "preview", "--scope", VERCEL_SCOPE], { timeout: 60_000 });
  const urls = [...new Set(r.output.match(/https:\/\/[a-z0-9.-]+\.vercel\.app\b/g) ?? [])];
  const log = writeLog(ctx, "no-preview-deployments.log", `$ vercel list ${VERCEL_PROJECT} --environment preview --scope ${VERCEL_SCOPE}\nexit ${r.status}\n${r.output}`);
  record(ctx, "no-preview-deployments", r.status === 0 && urls.length === 0, { exitCode: r.status, previewDeployments: urls, log });
}

function runPlaywright(ctx, pwCases) {
  if (ctx.o.skipPlaywright) {
    ctx.say("  skipped (--skip-playwright)");
    return;
  }
  if (!process.env.JUDGE_CODE?.trim()) ctx.say("  warning: JUDGE_CODE is not set; judge-path will fail");
  const env = {
    ...process.env,
    RETROFIT_PROD_URL: ctx.o.prod,
    RETROFIT_DEPLOYMENT_ID: ctx.o.deploymentId,
    RETROFIT_DEPLOYMENT_URL: ctx.o.deploymentUrl,
    RETROFIT_EVIDENCE_DIR: ctx.o.evidenceRoot,
    RETROFIT_RUN_ID: ctx.runId,
  };
  const r = spawnSync("pnpm", PLAYWRIGHT_ARGV, { cwd: ROOT, env, stdio: "inherit", timeout: 1_800_000 });
  ctx.playwrightExit = typeof r?.status === "number" ? r.status : -1;
  ctx.say(`  playwright exit ${ctx.playwrightExit}`);
  for (const id of pwCases) {
    const file = path.join(ctx.o.dir, `${id}.json`);
    if (!fs.existsSync(file)) {
      ctx.say(`  MISSING ${id}`);
      continue;
    }
    const status = JSON.parse(fs.readFileSync(file, "utf8")).status;
    ctx.results.set(id, status === "passed");
    ctx.say(`  ${status === "passed" ? "passed" : "FAILED"} ${id}`);
  }
}

/**
 * @param {string[]} argv
 * @param {{stdout: (s: string) => void, stderr: (s: string) => void}} [io]
 * @param {{inspect?: typeof vercelInspect}} [deps] the alias inspector (Vercel's CLI by default)
 */
export async function main(argv, io = { stdout: (s) => console.log(s), stderr: (s) => console.error(s) }, deps = {}) {
  let o;
  try {
    o = parseArgs(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    io.stderr(`production-evidence: ${error.message}`);
    return 2;
  }
  const cases = requiredCases();
  const pwCases = playwrightCases();
  const plan = steps(o, cases, pwCases);
  const produced = new Set(plan.flatMap((s) => s.produces));
  const missing = cases.map((c) => c.id).filter((id) => !produced.has(id));

  const lines = [];
  const say = (s) => {
    lines.push(s);
    io.stdout(s);
  };
  say(`production-evidence: ${o.dryRun ? "DRY RUN, nothing is contacted" : "contacting production"}`);
  say(`deployment ${o.deploymentId} ${o.deploymentUrl}, commit ${o.commit}, production ${o.prod}`);
  say(`evidence ${o.dir}`);
  say(`covers ${cases.length - missing.length} of ${cases.length} required production cases${missing.length ? `; no step produces: ${missing.join(", ")}` : ""}`);
  const earlier = fs.existsSync(o.dir) && fs.readdirSync(o.dir).length > 0;
  const aside = `${o.dir}.previous-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  if (o.dryRun) {
    if (earlier) say(o.fresh ? `would move the earlier evidence to ${aside}` : `would refuse: ${o.dir} already holds evidence; pass --fresh to move it aside`);
    say("writes run.json with a new run id; every case report carries it");
    plan.forEach((s, i) => {
      say(`step ${i + 1} ${s.name} -> ${s.produces.join(", ") || "nothing yet"}`);
      for (const line of s.show) say(`  ${line}`);
    });
    say(`then: node tools/release/analyze-evidence.mjs ${o.commit} --production ${path.relative(ROOT, o.dir) || o.dir}`);
    return missing.length === 0 ? 0 : 1;
  }

  if (earlier && !o.fresh) {
    io.stderr(`production-evidence: ${o.dir} already holds evidence from an earlier run; pass --fresh to move it to ${aside} first`);
    return 2;
  }
  if (earlier) {
    fs.renameSync(o.dir, aside);
    say(`moved the earlier evidence to ${aside}`);
  }
  const ctx = {
    o,
    say,
    runId: `run_${randomBytes(8).toString("hex")}`,
    startedAt: new Date().toISOString(),
    served: "unavailable (not read)",
    results: new Map(),
    playwrightExit: null,
    cases,
    inspect: deps.inspect ?? vercelInspect,
    identityBefore: null,
    stop: false,
  };
  for (const [i, s] of plan.entries()) {
    if (ctx.stop) break;
    say(`step ${i + 1} ${s.name} -> ${s.produces.join(", ") || "nothing yet"}`);
    try {
      await s.run(ctx);
    } catch (error) {
      if (error instanceof UsageError) {
        io.stderr(`production-evidence: ${error.message}`);
        return 2;
      }
      throw error;
    }
  }
  const failed = [...ctx.results].filter(([, passed]) => !passed).map(([id]) => id);
  const absent = cases.map((c) => c.id).filter((id) => !ctx.results.has(id));
  say(`summary: ${ctx.results.size - failed.length} passed, ${failed.length} failed${failed.length ? ` (${failed.join(", ")})` : ""}, ${absent.length} missing${absent.length ? ` (${absent.join(", ")})` : ""}`);
  say(`next: node tools/release/analyze-evidence.mjs ${o.commit} --production ${path.relative(ROOT, o.dir) || o.dir}`);
  fs.writeFileSync(path.join(o.dir, "production-evidence.log"), `${lines.join("\n")}\n`);
  return failed.length === 0 && absent.length === 0 && (ctx.playwrightExit === null || ctx.playwrightExit === 0) ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
