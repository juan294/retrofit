"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { COUNTING_RETRY_S, visitorTexts } from "@/lib/analysis/texts";
import { AgentPanel } from "@/components/preview/AgentPanel";
import { ScanField } from "./ScanField";
import styles from "./Scan.module.css";
import { InstallPanel } from "./InstallPanel";
import { signInHref } from "@/lib/accounts/return-to";
import { SAVE_REPORT_TEXT } from "@/lib/site/account-texts";
import { SaveReportButton } from "./SaveReportButton";
import { SignInForm } from "../SignInForm";
import { buttonState } from "../useOneAtATime";
import { ScoreReport, type ReportView } from "./ScoreReport";
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
interface Report extends ReportView {
  bundleReady: boolean;
}

const STEP_TEXT: Record<string, string> = {
  queued: "Waiting for a free crawler",
  home: "Reading the home page",
  claim: "Reading the home page",
  joined: "Joining a crawl of the same site",
};
function stepText(s: Status | null): string {
  if (!s) return "Getting the analysis status";
  if (s.status === "ready") return "Preparing your report";
  if (s.status === "queued") return STEP_TEXT.queued!;
  if (s.step.startsWith("probe")) return "Checking robots.txt, sitemap, llms.txt and agent manifest";
  if (s.step.startsWith("page")) return `Reading linked pages (${s.step})`;
  return STEP_TEXT[s.step] ?? "Reading the site";
}

/**
 * The one status region of the results page. It stays mounted from the first render to the report, so a
 * screen reader announces each step and then that the report is ready. A failure is an alert of its own (Notice).
 */
export function AnalysisStatus({ state, status }: { state: "working" | "ready" | "failed"; status: Status | null }) {
  return (
    <div role="status">
      {state === "ready" ? <p className="sr-only">The report is ready.</p> : null}
      {state === "working" ? (
        <div className={styles.scan} data-testid="analysis-progress">
          <ScanField />
          <div className={styles.readout}>
            <p>{stepText(status)}</p>
            {status?.status === "queued" ? <p>{visitorTexts.queued}</p> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** `canSave`: the visitor is signed in, so the ready report offers "Save this report". */
export function AnalysisView({ id, inputOrigin, canSave = false }: { id: string; inputOrigin: string; canSave?: boolean }) {
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

  const ended = status?.status === "failed" || status?.status === "expired";
  const failure = error ?? (ended ? (status.failure ?? { code: "crawl_error", message: visitorTexts.crawlError }) : null);
  const ready = status?.status === "ready" ? report : null;
  return (
    <>
      <AnalysisStatus state={failure ? "failed" : ready ? "ready" : "working"} status={status} />
      {failure ? <Notice failure={failure} inputOrigin={inputOrigin} /> : ready ? <ReadyReport id={id} report={ready} canSave={canSave} /> : null}
    </>
  );
}

function ReadyReport({ id, report, canSave }: { id: string; report: Report; canSave: boolean }) {
  return (
    <ScoreReport report={report} readOn={new Date(report.fetchedAt).toLocaleString()}>
      <AgentPanel
        basePath={`/p/${id}`}
        title="Try the agent Retrofit built"
        label={`Private preview. Unofficial. Built by Retrofit from public pages of ${report.host} on ${report.fetchedAt.slice(0, 10)}. Not affiliated with ${report.host}.`}
      />

      <InstallPanel id={id} host={report.host} score={report.score} available={report.bundleReady} />

      {canSave ? (
        <SaveReportButton analysisId={id} />
      ) : (
        <p className="mt-8">
          <a href={signInHref(`/r/${id}`)} className="underline">
            {SAVE_REPORT_TEXT.signIn}
          </a>
        </p>
      )}
    </ScoreReport>
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
    <>
      <div className="mt-8" role="alert">
        <p>{waiting ?? localizeRetry(shown.message, shown.retryAt)}</p>
        <p className="mt-4 flex gap-3">
          {RETRYABLE.has(failure.code) && !(failure.retryAt && Date.parse(failure.retryAt) > Date.now()) ? (
            <button type="button" onClick={() => busy || starts.current?.start(inputOrigin)} {...buttonState(true, busy)} className="rounded px-4 py-2 font-medium" style={{ background: "var(--color-accent)", color: "var(--color-accent-text)" }}>
              {busy ? "Starting…" : failure.code === "expired" ? "Analyze again" : "Retry"}
            </button>
          ) : null}
          <a href="/" className="rounded border px-4 py-2" style={{ borderColor: "var(--color-border)" }}>
            Analyze another site
          </a>
        </p>
      </div>
      {shown.code === "free_limit" ? <SignInForm returnTo="/" privacyHref="/privacy" /> : null}
    </>
  );
}
