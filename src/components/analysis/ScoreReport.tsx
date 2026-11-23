import type { ReactNode } from "react";
import type { CheckId } from "@/lib/score/checks";
import { FIX_HINTS, fixFirst } from "@/lib/score/fixes";

export interface CheckView {
  id: string;
  group: string;
  weight: number;
  result: "pass" | "fail" | "not-checked";
  rule: string;
  evidence: string;
}

/** The score/v1 report fields the page shows. */
export interface ReportView {
  host: string;
  score: number | null;
  summary: string;
  webmcp: string;
  fetchedAt: string;
  checks: CheckView[];
}

/** A stored report (saved or published) as the page shows it: a stored value, so a missing check list is empty. */
export function storedReportView(report: Record<string, unknown>): ReportView {
  const view = report as unknown as ReportView;
  return { ...view, checks: Array.isArray(view.checks) ? view.checks : [] };
}

const RESULT_TEXT = { pass: "pass", fail: "fail", "not-checked": "not checked" } as const;

/**
 * A score report: the score, "Fix these first", then `children` (the results page puts the
 * agent preview, the install panel and "Save this report" there), then every check. Shared by
 * the live results page (a client component) and the saved report view (a server component).
 * `readOn` is the fetch time as the caller formats it.
 */
export function ScoreReport({ report, readOn, children }: { report: ReportView; readOn: string; children?: ReactNode }) {
  const groups = [...new Set(report.checks.map((c) => c.group))];
  const checked = report.checks.filter((c) => c.result !== "not-checked").length;
  const passed = report.checks.filter((c) => c.result === "pass").length;
  const fixes = fixFirst(report.checks);
  return (
    <section className="mt-8" aria-labelledby="score-heading">
      <h2 id="score-heading" className="sr-only">
        Score
      </h2>
      <p className="text-5xl font-semibold">
        {report.score === null ? <span>No score</span> : <span data-testid="score-total">{report.score}</span>}
        {report.score === null ? null : <span className="text-xl font-normal"> / 100</span>}
      </p>
      <p className="mt-2" data-testid="score-passed">
        {passed} of {checked} checks passed.
      </p>
      <p className="mt-1 text-sm" style={{ color: "var(--color-muted)" }}>
        Read on {readOn}.
      </p>

      {fixes.length ? (
        <div className="mt-8" data-testid="fix-first">
          <h3 className="text-lg font-semibold">Fix these first</h3>
          <ol className="mt-2 flex list-decimal flex-col gap-2 pl-5">
            {fixes.map((c) => (
              <li key={c.id}>
                <span className="font-medium">{FIX_HINTS[c.id as CheckId] ?? c.rule}</span>{" "}
                <span className="text-sm" style={{ color: "var(--color-muted)" }}>
                  ({c.weight} points)
                </span>
              </li>
            ))}
          </ol>
        </div>
      ) : null}

      {children}

      <h3 className="mt-12 text-lg font-semibold">All checks</h3>
      <p className="mt-1 text-sm" style={{ color: "var(--color-muted)" }}>
        {report.summary} WebMCP tools: {report.webmcp}.
      </p>
      {groups.map((g) => (
        <div key={g} className="mt-6">
          <h4 className="font-semibold">{g}</h4>
          <ul className="mt-2 flex flex-col gap-2">
            {report.checks
              .filter((c) => c.group === g)
              .map((c) => (
                <li key={c.id} data-testid={`check-${c.id}`} className="rounded border p-3" style={{ borderColor: "var(--color-border)" }}>
                  <p>
                    <strong style={{ color: c.result === "pass" ? "var(--color-ok)" : c.result === "fail" ? "var(--color-danger)" : "var(--color-muted)" }}>
                      {RESULT_TEXT[c.result]}
                    </strong>{" "}
                    {c.rule} <span style={{ color: "var(--color-muted)" }}>({c.weight} points)</span>
                  </p>
                  <p className="mt-1 text-sm" style={{ color: "var(--color-muted)" }}>
                    {c.evidence}
                  </p>
                </li>
              ))}
          </ul>
        </div>
      ))}
    </section>
  );
}
