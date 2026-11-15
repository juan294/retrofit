// One production case report (phase-7.md, "Production evidence (step 12)"), in the shape that
// tools/release/analyze-evidence.mjs reads in production mode:
//   <evidence root>/<deployment id>/<case>.json
//   {case, status, deploymentId, deploymentUrl, commit, recordedAt, ...extra}
// Shared by e2e-prod/support/report.ts (Playwright cases) and tools/release/production-evidence.mjs
// (partner, probe and Vercel cases), so both write the same shape. Plain JavaScript, so the
// release script can import it without a TypeScript loader.
import fs from "node:fs";
import path from "node:path";

export const DEFAULT_PROD_URL = "https://retrofit.thecreativetoken.com";
export const CASE_ID = /^[a-z0-9][a-z0-9-]*$/;
export const DEPLOYMENT_ID = /^dpl_[A-Za-z0-9]+$/;
export const STATUSES = ["passed", "failed"];
const BINDING = ["case", "status", "deploymentId", "deploymentUrl", "commit", "recordedAt"];

/**
 * Builds a case report. Binding fields always win over `extra`, so extra data can never
 * rebind a report to another case, deployment or commit.
 *
 * @param {{caseId: string, status: string, deploymentId: string, deploymentUrl: string, commit: string, recordedAt?: string, extra?: Record<string, unknown>}} o
 * @returns {Record<string, unknown>}
 */
export function caseReport(o) {
  if (!CASE_ID.test(o.caseId ?? "")) throw new Error(`invalid case id ${JSON.stringify(o.caseId)}`);
  if (!STATUSES.includes(o.status)) throw new Error(`invalid case status ${JSON.stringify(o.status)}`);
  if (!DEPLOYMENT_ID.test(o.deploymentId ?? "")) throw new Error(`invalid deployment id ${JSON.stringify(o.deploymentId)}`);
  if (typeof o.deploymentUrl !== "string" || !o.deploymentUrl.startsWith("https://")) {
    throw new Error(`invalid deployment URL ${JSON.stringify(o.deploymentUrl)}`);
  }
  const extra = Object.fromEntries(Object.entries(o.extra ?? {}).filter(([key]) => !BINDING.includes(key)));
  return {
    ...extra,
    case: o.caseId,
    status: o.status,
    deploymentId: o.deploymentId,
    deploymentUrl: o.deploymentUrl,
    commit: typeof o.commit === "string" && o.commit ? o.commit : "unavailable",
    recordedAt: o.recordedAt ?? new Date().toISOString(),
  };
}

/**
 * Writes a report built by caseReport to <evidenceRoot>/<deploymentId>/<case>.json.
 *
 * @param {string} evidenceRoot
 * @param {Record<string, unknown>} report
 * @returns {string} the file written
 */
export function writeCaseFile(evidenceRoot, report) {
  const dir = path.join(evidenceRoot, String(report.deploymentId));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${report.case}.json`);
  fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  return file;
}
