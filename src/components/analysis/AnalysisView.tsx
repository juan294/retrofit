"use client";

import { useEffect, useRef, useState } from "react";
import { FINAL_STATUSES, pollDelay } from "./poll";

interface Failure {
  code: string;
  message: string;
  retryAt?: string;
}
interface Status {
  status: "queued" | "crawling" | "ready" | "failed" | "expired";
  step: string;
  failure?: Failure;
  scoreReady: boolean;
}
interface Check {
  id: string;
  group: string;
  weight: number;
  result: "pass" | "fail" | "not-checked";
  rule: string;
  evidence: string;
}
interface Report {
  score: number | null;
  summary: string;
  webmcp: string;
  fetchedAt: string;
  checks: Check[];
}

const STEP_TEXT: Record<string, string> = {
  queued: "Waiting for a free crawler",
  home: "Reading the home page",
  claim: "Reading the home page",
  joined: "Joining a crawl of the same site",
};
function stepText(s: Status): string {
  if (s.status === "queued") return STEP_TEXT.queued!;
  if (s.step.startsWith("probe")) return "Checking robots.txt, sitemap, llms.txt and agent manifest";
  if (s.step.startsWith("page")) return `Reading linked pages (${s.step})`;
  return STEP_TEXT[s.step] ?? "Reading the site";
}

const RESULT_TEXT = { pass: "pass", fail: "fail", "not-checked": "not checked" } as const;

export function AnalysisView({ id }: { id: string }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(Date.now());

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    async function tick() {
      if (stopped) return;
      if (document.visibilityState === "hidden") return; // resumed by visibilitychange
      try {
        const res = await fetch(`/api/analyze/${id}`, { credentials: "same-origin", cache: "no-store" });
        const body = await res.json();
        if (!res.ok) {
          setError(body.message ?? "Retrofit is having trouble. Try again in a few minutes.");
          return;
        }
        setStatus(body);
        if (body.scoreReady) {
          const full = await fetch(`/api/analyze/${id}?include=result`, { credentials: "same-origin", cache: "no-store" });
          if (full.ok) setReport((await full.json()).report);
        }
        if (FINAL_STATUSES.has(body.status)) return;
      } catch {
        // Network hiccup: keep polling.
      }
      timer = setTimeout(tick, pollDelay(Date.now() - started.current));
    }
    const onVisible = () => {
      if (document.visibilityState === "visible" && !stopped) {
        clearTimeout(timer);
        void tick();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [id]);

  if (error) return <Notice text={error} />;
  if (!status) return <p className="mt-8">Loading…</p>;
  if (status.status === "failed" || status.status === "expired") {
    return <Notice text={status.failure?.message ?? "Retrofit could not read this site."} />;
  }
  if (status.status !== "ready" || !report) {
    return (
      <div className="mt-8" data-testid="analysis-progress" role="status" aria-live="polite">
        <p className="font-medium">{status.status === "queued" ? "Retrofit is busy. Your analysis starts in a moment." : "Reading the site…"}</p>
        <p className="mt-1" style={{ color: "var(--color-muted)" }}>
          {stepText(status)}
        </p>
      </div>
    );
  }

  const groups = [...new Set(report.checks.map((c) => c.group))];
  return (
    <section className="mt-8" aria-labelledby="score-heading">
      <h2 id="score-heading" className="sr-only">
        Score
      </h2>
      <p className="text-5xl font-semibold">
        {report.score === null ? <span>No score</span> : <span data-testid="score-total">{report.score}</span>}
        {report.score === null ? null : <span className="text-xl font-normal"> / 100</span>}
      </p>
      <p className="mt-2">{report.summary}</p>
      <p className="mt-1 text-sm" style={{ color: "var(--color-muted)" }}>
        Read on {new Date(report.fetchedAt).toLocaleString()}. WebMCP: {report.webmcp}
      </p>
      {groups.map((g) => (
        <div key={g} className="mt-6">
          <h3 className="text-lg font-semibold">{g}</h3>
          <ul className="mt-2 flex flex-col gap-2">
            {report.checks
              .filter((c) => c.group === g)
              .map((c) => (
                <li key={c.id} data-testid={`check-${c.id}`} className="rounded border p-3" style={{ borderColor: "var(--color-border)" }}>
                  <p>
                    <strong style={{ color: c.result === "pass" ? "var(--color-ok)" : c.result === "fail" ? "var(--color-danger)" : "var(--color-muted)" }}>
                      {RESULT_TEXT[c.result]}
                    </strong>{" "}
                    {c.rule} <span style={{ color: "var(--color-muted)" }}>({c.weight})</span>
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

function Notice({ text }: { text: string }) {
  return (
    <div className="mt-8" role="alert">
      <p>{text}</p>
      <p className="mt-4">
        <a href="/" className="rounded px-4 py-2 font-medium" style={{ background: "var(--color-accent)", color: "var(--color-accent-text)" }}>
          Analyze a site
        </a>
      </p>
    </div>
  );
}
