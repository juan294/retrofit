"use client";

import { FIX_HINTS, fixFirst } from "@/lib/score/fixes";
import type { CheckId } from "@/lib/score/checks";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { COUNTING_RETRY_S, visitorTexts } from "@/lib/analysis/texts";
import { AgentPanel } from "@/components/preview/AgentPanel";
import { InstallPanel } from "./InstallPanel";
import { localizeRetry } from "./retry-time";
import { COUNTING_ATTEMPTS } from "./request";
import { createStartController, type StartController, type StartState } from "./start-controller";
import { pollAction, pollDelay } from "./poll";

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
  bundleReady: boolean;
  host: string;
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

export function AnalysisView({ id, inputOrigin }: { id: string; inputOrigin: string }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<Failure | null>(null);
  const started = useRef(Date.now());

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let done = false;
    let inFlight = false;
    const schedule = () => {
      clearTimeout(timer);
      if (!done) timer = setTimeout(tick, pollDelay(Date.now() - started.current));
    };
    const finish = () => {
      done = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
    async function tick() {
      if (done || inFlight) return;
      if (document.visibilityState === "hidden") return; // resumed by visibilitychange
      inFlight = true;
      try {
        const res = await fetch(`/api/analyze/${id}`, { credentials: "same-origin", cache: "no-store" });
        const body = await res.json();
        if (!res.ok) {
          setError({ code: body.error ?? "unavailable", message: body.message ?? visitorTexts.unavailable, retryAt: body.retryAt });
          finish();
          return;
        }
        setStatus(body);
        const action = pollAction(body);
        if (action === "read-result") {
          const full = await fetch(`/api/analyze/${id}?include=result`, { credentials: "same-origin", cache: "no-store" });
          const fullBody = full.ok ? await full.json() : null;
          if (fullBody?.report) {
            setReport({ ...fullBody.report, bundleReady: fullBody.bundleReady === true });
            finish();
            return;
          }
          // The result read failed: keep polling.
        } else if (action === "stop") {
          finish();
          return;
        }
      } catch {
        // Network hiccup: keep polling.
      } finally {
        inFlight = false;
      }
      schedule();
    }
    function onVisible() {
      if (document.visibilityState === "visible" && !done) {
        clearTimeout(timer);
        void tick();
      }
    }
    document.addEventListener("visibilitychange", onVisible);
    void tick();
    return () => {
      finish();
    };
  }, [id]);

  if (error) return <Notice failure={error} inputOrigin={inputOrigin} />;
  if (!status) return <p className="mt-8">Loading…</p>;
  if (status.status === "failed" || status.status === "expired") {
    return <Notice failure={status.failure ?? { code: "crawl_error", message: visitorTexts.crawlError }} inputOrigin={inputOrigin} />;
  }
  if (status.status !== "ready" || !report) {
    return (
      <div className="mt-8" data-testid="analysis-progress" role="status" aria-live="polite">
        <p className="font-medium">{status.status === "queued" ? visitorTexts.queued : "Reading the site…"}</p>
        <p className="mt-1" style={{ color: "var(--color-muted)" }}>
          {stepText(status)}
        </p>
      </div>
    );
  }

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
        Read on {new Date(report.fetchedAt).toLocaleString()}.
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

      <AgentPanel
        basePath={`/p/${id}`}
        title="Try the agent Retrofit built"
        label={`Private preview. Unofficial. Built by Retrofit from public pages of ${report.host} on ${report.fetchedAt.slice(0, 10)}. Not affiliated with ${report.host}.`}
      />

      <InstallPanel id={id} host={report.host} score={report.score} available={report.bundleReady} />

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

/** Failures that a new analysis of the same address can fix. Retry is hidden until any retryAt has passed. */
const RETRYABLE = new Set(["stale", "queue_expired", "crawl_error", "robots_unavailable", "unavailable", "expired", "counting"]);

function Notice({ failure, inputOrigin }: { failure: Failure; inputOrigin: string }) {
  const router = useRouter();
  const [retryError, setRetryError] = useState<Failure | null>(null);
  const [{ busy, waiting }, setState] = useState<StartState>({ busy: false, waiting: null });
  const starts = useRef<StartController | null>(null);
  const autoRetry = failure.code === "counting";
  // One start at a time: a click during the automatic retry's wait replaces it, and leaving the page
  // aborts the start so a late answer never navigates.
  useEffect(() => {
    const controller = createStartController({
      onState: setState,
      onResult: (r) => (r.ok ? router.push(`/r/${r.id}`) : setRetryError(r.failure)),
    });
    starts.current = controller;
    // A job held back while the site's daily count was undecided: start again by itself after a moment.
    if (autoRetry) controller.schedule(inputOrigin, COUNTING_RETRY_S * 1000, visitorTexts.countingRetry, COUNTING_ATTEMPTS - 1);
    return () => controller.dispose();
  }, [autoRetry, inputOrigin, router]);
  const shown = retryError ?? failure;
  return (
    <div className="mt-8" role="alert">
      <p>{waiting ?? localizeRetry(shown.message, shown.retryAt)}</p>
      <p className="mt-4 flex gap-3">
        {RETRYABLE.has(failure.code) && !(failure.retryAt && Date.parse(failure.retryAt) > Date.now()) ? (
          <button type="button" onClick={() => starts.current?.start(inputOrigin)} disabled={busy} className="rounded px-4 py-2 font-medium" style={{ background: "var(--color-accent)", color: "var(--color-accent-text)" }}>
            {busy ? "Starting…" : failure.code === "expired" ? "Analyze again" : "Retry"}
          </button>
        ) : null}
        <a href="/" className="rounded border px-4 py-2" style={{ borderColor: "var(--color-border)" }}>
          Analyze another site
        </a>
      </p>
    </div>
  );
}
