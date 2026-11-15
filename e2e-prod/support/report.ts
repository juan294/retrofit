// Writes one production case report for a Playwright case (phase-7.md, "Production evidence
// (step 12)"). The deployment id and URL come from the release script's environment; the
// commit comes from the deployment's own /api/version, so a report binds to what actually served it.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_PROD_URL, caseReport, writeCaseFile } from "./case-report.mjs";

export type CaseStatus = "passed" | "failed";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

type Env = Record<string, string | undefined>;

export interface WriteCaseOptions {
  readonly env?: Env;
  readonly fetch?: typeof fetch;
}

/** The production origin the cases run against (RETROFIT_PROD_URL, else the public domain). */
export const prodUrl = (env: Env = process.env) => (env.RETROFIT_PROD_URL?.trim() || DEFAULT_PROD_URL).replace(/\/+$/, "");

/** .local/evidence/production, or RETROFIT_EVIDENCE_DIR (relative to the repository root). */
export const evidenceRoot = (env: Env = process.env) => path.resolve(ROOT, env.RETROFIT_EVIDENCE_DIR?.trim() || ".local/evidence/production");

const commits = new Map<string, Promise<string>>();

/** The commit from <prod>/api/version, read once per process and origin; "unavailable (...)" when it cannot be read. */
export function deployedCommit(env: Env = process.env, fetchImpl: typeof fetch = fetch): Promise<string> {
  const url = `${prodUrl(env)}/api/version`;
  let pending = commits.get(url);
  if (!pending) {
    pending = (async () => {
      try {
        const res = await fetchImpl(url, { cache: "no-store", signal: AbortSignal.timeout(30_000) });
        const body = (await res.json().catch(() => null)) as { commit?: unknown } | null;
        if (res.ok && typeof body?.commit === "string" && body.commit) return body.commit;
        return `unavailable (status ${res.status})`;
      } catch (e) {
        return `unavailable (${e instanceof Error ? e.name : "error"})`;
      }
    })();
    commits.set(url, pending);
  }
  return pending;
}

/** Clears the per-process commit cache (tests only). */
export function resetCommitCache() {
  commits.clear();
}

/**
 * Writes <evidence root>/<RETROFIT_DEPLOYMENT_ID>/<caseId>.json and returns its path.
 * Throws when the deployment id or URL is missing: a report without them binds to nothing.
 */
export async function writeCase(caseId: string, status: CaseStatus, extra: Record<string, unknown> = {}, options: WriteCaseOptions = {}): Promise<string> {
  const env = options.env ?? process.env;
  const deploymentId = env.RETROFIT_DEPLOYMENT_ID?.trim();
  const deploymentUrl = env.RETROFIT_DEPLOYMENT_URL?.trim();
  if (!deploymentId || !deploymentUrl) {
    throw new Error("RETROFIT_DEPLOYMENT_ID and RETROFIT_DEPLOYMENT_URL must be set (tools/release/production-evidence.mjs sets them)");
  }
  const commit = await deployedCommit(env, options.fetch ?? fetch);
  const report = caseReport({ caseId, status, deploymentId, deploymentUrl, commit, extra });
  return writeCaseFile(evidenceRoot(env), report);
}
