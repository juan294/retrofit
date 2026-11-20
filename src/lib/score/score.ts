// score/v1: a deterministic agent-readiness score with evidence (phase-3.md "Score version").
// The report shape is the tool contract's ScoreReport (docs/research/score-tool-contract.md,
// "Ready: 200 ScoreReport") without `status` and `cachedUntil`, which the route adds.
// Any rule or weight change needs a new score version.

import type { Snapshot } from "@/lib/snapshot/types";
import { CHECK_DEFINITIONS, CHECKS, MAX_EVIDENCE_CHARS, type CheckId, type CheckResult } from "./checks";

export { MAX_EVIDENCE_CHARS };
export type { CheckId, CheckResult };

export const SCORE_VERSION = "score/v1";
export const MAX_REPORT_BYTES = 16_384;
/** Fewer checked checks than this gives no score. */
export const MIN_CHECKED = 3;

export const CHECK_IDS: readonly CheckId[] = CHECK_DEFINITIONS.map((d) => d.id);
export const SCORE_WEIGHTS = Object.freeze(Object.fromEntries(CHECK_DEFINITIONS.map((d) => [d.id, d.weight])) as Record<CheckId, number>);

const TOTAL_WEIGHT = CHECK_DEFINITIONS.reduce((sum, d) => sum + d.weight, 0);
if (TOTAL_WEIGHT !== 100 || CHECK_IDS.length !== 16) throw new Error(`score/v1 weights must total 100 over 16 checks (got ${TOTAL_WEIGHT} over ${CHECK_IDS.length}).`);

export interface ScoreReport {
  scoreVersion: typeof SCORE_VERSION;
  /** The scored origin's home page (the snapshot's inputUrl). */
  url: string;
  finalUrl: string;
  host: string;
  fetchedAt: string;
  /** 0 to 100, or null when fewer than MIN_CHECKED checks were checked. */
  score: number | null;
  checked: number;
  total: number;
  passed: number;
  webmcp: "not checked";
  summary: string;
  checks: CheckResult[];
}

/** Score = floor(passed weight / checked weight x 100); null below MIN_CHECKED checked checks. */
export function scoreChecks(checks: readonly CheckResult[]): Pick<ScoreReport, "score" | "checked" | "passed" | "summary"> {
  const checkedList = checks.filter((c) => c.result !== "not-checked");
  const checked = checkedList.length;
  const passed = checkedList.filter((c) => c.result === "pass").length;
  if (checked < MIN_CHECKED) {
    return { score: null, checked, passed, summary: `Retrofit could check only ${checked} of ${CHECK_IDS.length} checks, so there is no score.` };
  }
  const checkedWeight = checkedList.reduce((sum, c) => sum + c.weight, 0);
  const passedWeight = checkedList.filter((c) => c.result === "pass").reduce((sum, c) => sum + c.weight, 0);
  // Integer arithmetic, so no float rounding moves a score across a boundary.
  const score = Math.floor((passedWeight * 100) / checkedWeight);
  const skipped = checks.length - checked;
  const notChecked = skipped === 0 ? `All ${checks.length} checks were checked.` : `${skipped} ${skipped === 1 ? "check was" : "checks were"} not checked.`;
  return { score, checked, passed, summary: `Agent-readiness score ${score} of 100 (${SCORE_VERSION}). ${passed} of ${checked} checked checks passed. ${notChecked}` };
}

/** Score a snapshot. Pure: the same snapshot always gives the same report. */
export function scoreSnapshot(snapshot: Snapshot): ScoreReport {
  const checks = CHECK_IDS.map((id) => CHECKS[id](snapshot));
  const { score, checked, passed, summary } = scoreChecks(checks);
  return {
    scoreVersion: SCORE_VERSION,
    url: snapshot.inputUrl,
    finalUrl: snapshot.finalUrl,
    host: snapshot.host,
    fetchedAt: snapshot.fetchedAt,
    score,
    checked,
    total: CHECK_IDS.length,
    passed,
    webmcp: "not checked",
    summary,
    checks,
  };
}
