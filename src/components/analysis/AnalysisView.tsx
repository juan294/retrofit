"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { visitorTexts } from "@/lib/analysis/texts";
import { AgentPanel } from "@/components/preview/AgentPanel";
import { localizeRetry } from "./retry-time";
import { COUNTING_ATTEMPTS, requestAnalysis } from "./request";
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
            setReport(fullBody.report);
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
      <AgentPanel
        basePath={`/p/${id}`}
        title="Try the agent Retrofit built"
        label={`Private preview. Unofficial. Built by Retrofit from public pages of ${report.host} on ${report.fetchedAt.slice(0, 10)}. Not affiliated with ${report.host}.`}
      />
    </section>
  );
}

/** Failures that a new analysis of the same address can fix. Retry is hidden until any retryAt has passed. */
const RETRYABLE = new Set(["stale", "queue_expired", "crawl_error", "robots_unavailable", "unavailable", "expired", "counting"]);
/** Wait before the page retries a `counting` failure by itself (the server's retry time for it). */
const COUNTING_RETRY_MS = 2000;

function Notice({ failure, inputOrigin }: { failure: Failure; inputOrigin: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [retryError, setRetryError] = useState<Failure | null>(null);
  const [waiting, setWaiting] = useState<string | null>(null);
  async function retry(attempts?: number) {
    setBusy(true);
    const result = await requestAnalysis(inputOrigin, { onRetry: setWaiting, attempts });
    setWaiting(null);
    if (result.ok) {
      router.push(`/r/${result.id}`);
      return;
    }
    setRetryError(result.failure);
    setBusy(false);
  }
  // A job held back while the site's daily count was undecided: start again by itself, once, after a moment.
  const autoRetry = failure.code === "counting";
  useEffect(() => {
    if (!autoRetry) return;
    setWaiting(visitorTexts.countingRetry);
    const timer = setTimeout(() => void retry(COUNTING_ATTEMPTS - 1), COUNTING_RETRY_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once for the failure shown on mount.
  }, [autoRetry]);
  const shown = retryError ?? failure;
  return (
    <div className="mt-8" role="alert">
      <p>{waiting ?? localizeRetry(shown.message, shown.retryAt)}</p>
      <p className="mt-4 flex gap-3">
        {RETRYABLE.has(failure.code) && !(failure.retryAt && Date.parse(failure.retryAt) > Date.now()) ? (
          <button type="button" onClick={() => void retry()} disabled={busy} className="rounded px-4 py-2 font-medium" style={{ background: "var(--color-accent)", color: "var(--color-accent-text)" }}>
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
