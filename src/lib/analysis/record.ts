import { randomBytes } from "node:crypto";
import type { Config } from "@/lib/config";
import { isQueueExpired, readJobMarkingStale, type CrawlFailure, type CrawlJob, type JobDeps } from "@/lib/crawl/jobs";
import type { Snapshot } from "@/lib/snapshot/types";
import type { Store } from "@/lib/store/types";
import { setAccountAnalysisHost } from "./account-list";
import { visitorFailure, visitorTexts } from "./texts";

/**
 * A visitor-owned analysis. It links one visitor (by cookie hash) to a shared
 * crawl job. When the job is ready, the analysis copies the snapshot and score,
 * so the preview survives the 24 h crawl cache until the analysis expires.
 */
export type AnalysisStatus = "queued" | "crawling" | "ready" | "failed" | "expired";

export interface Analysis<R = unknown> {
  readonly version: number;
  readonly id: string;
  readonly ownerHash: string;
  /**
   * The account the analysis is attached to: set at creation for a signed-in visitor, or when the
   * visitor signs in (src/lib/analysis/owner.ts). Absent on anonymous and older records.
   */
  readonly accountId?: string;
  readonly jobId: string;
  readonly inputOrigin: string;
  readonly createdAt: number;
  /** createdAt + ANALYSIS_TTL_S. */
  readonly expiresAt: number;
  /** The ready job's updatedAt, for the report's cachedUntil. */
  readonly readyAt?: number;
  readonly snapshot?: Snapshot;
  readonly score?: R;
}

export interface VisitorFailure {
  readonly code: string;
  readonly message: string;
  readonly retryAt?: string;
}

export interface AnalysisView<R = unknown> {
  readonly status: AnalysisStatus;
  readonly step: string;
  readonly failure?: VisitorFailure;
  /** The analysis as now stored (with the copied snapshot and score once ready). */
  readonly analysis: Analysis<R>;
}

/** Expired analyses stay readable this long, so the visitor sees "expired on <date>" instead of a 404. */
export const EXPIRED_GRACE_S = 7 * 24 * 3600;
const ID = /^[0-9a-f]{32}$/;

export const analysisKey = (id: string) => `analysis:${id}`;

export function isAnalysisId(id: string): boolean {
  return ID.test(id);
}

export function newAnalysisId(): string {
  return randomBytes(16).toString("hex");
}

export function storeTtl(a: Pick<Analysis, "expiresAt">, now: number): number {
  return Math.max(1, Math.ceil((a.expiresAt + EXPIRED_GRACE_S * 1000 - now) / 1000));
}

export async function createAnalysis(
  deps: { store: Store; config: Config; clock: () => number },
  o: { ownerHash: string; jobId: string; inputOrigin: string; accountId?: string },
): Promise<Analysis> {
  const now = deps.clock();
  const analysis: Analysis = {
    version: 1,
    id: newAnalysisId(),
    ownerHash: o.ownerHash,
    ...(o.accountId ? { accountId: o.accountId } : {}),
    jobId: o.jobId,
    inputOrigin: o.inputOrigin,
    createdAt: now,
    expiresAt: now + deps.config.analysisTtlS * 1000,
  };
  await deps.store.set(analysisKey(analysis.id), analysis, storeTtl(analysis, now));
  return analysis;
}

export async function getAnalysis<R = unknown>(store: Store, id: string): Promise<Analysis<R> | null> {
  return store.get<Analysis<R>>(analysisKey(id));
}

/** The life of an account's analysis list (account-list.ts): every analysis it lists has left the Store by then. */
export const accountListTtl = (config: Pick<Config, "analysisTtlS">): number => config.analysisTtlS + EXPIRED_GRACE_S;

/** The host an analysis scored (its snapshot's host, after redirects), or before the score exists the typed origin's host. */
export function analysisHost(analysis: Pick<Analysis, "inputOrigin" | "snapshot">): string {
  const scored = (analysis.snapshot as { host?: unknown } | undefined)?.host;
  return typeof scored === "string" ? scored : new URL(analysis.inputOrigin).host;
}

export function isExpired(a: Pick<Analysis, "expiresAt">, now: number): boolean {
  return now >= a.expiresAt;
}

function failureView(f: CrawlFailure | undefined): VisitorFailure {
  const code = f?.code ?? "unavailable";
  const retryAt = f?.retryAt ? new Date(f.retryAt) : undefined;
  const valid = retryAt && !Number.isNaN(retryAt.getTime()) ? retryAt : undefined;
  return { code, message: visitorFailure(code, { retryAt: valid }), ...(valid ? { retryAt: valid.toISOString() } : {}) };
}

/**
 * The visitor's view of an analysis. Reads the job exactly once (through
 * readJobMarkingStale without following joins, which marks a stale job failed).
 * A `joined` job is reported as running (step "joined") and the analysis moves
 * to the job it joined, so the next read is again one analysis and one job read.
 * When the job is ready, the analysis copies its snapshot and score, so later
 * reads need no job read at all. A reader that loses the compare-and-set of
 * that copy answers with the same copy, so a ready view always carries the
 * score.
 */
export async function readAnalysisView<R>(deps: JobDeps, analysis: Analysis<R>): Promise<AnalysisView<R>> {
  const now = deps.clock();
  if (isExpired(analysis, now)) {
    return { status: "expired", step: "expired", failure: { code: "expired", message: visitorTexts.expired(new Date(analysis.expiresAt)) }, analysis };
  }
  if (analysis.snapshot !== undefined) return { status: "ready", step: "ready", analysis };

  const job = await readJobMarkingStale<Snapshot, R>(deps, analysis.jobId, { followJoins: false });
  if (!job) {
    // The job left the store before this analysis copied it (no read for over a day).
    return { status: "failed", step: "failed", failure: failureView({ code: "stale", message: "" }), analysis };
  }

  const joinedTo = job.status === "joined" ? job.joinedTo : undefined;
  let current = analysis;
  if (job.status === "ready" || joinedTo) {
    const next: Analysis<R> = {
      ...analysis,
      version: analysis.version + 1,
      jobId: joinedTo ?? job.id,
      ...(job.status === "ready" ? { snapshot: job.snapshot, score: job.score, readyAt: job.updatedAt } : {}),
    };
    // A lost compare-and-set means another reader (a second tab) copied first, or sign-in attached
    // the analysis to an account in between (owner.ts). Ready and joined jobs no longer change, so
    // the copy is the same either way: answer with `next`, with no extra read. After an attach the
    // next read copies again onto the attached record.
    await deps.store.compareAndSet(analysisKey(analysis.id), analysis, next, storeTtl(next, now));
    current = next;
    // The scored host is known now. It can differ from the typed one (a redirect), so the account's
    // list entry follows it; a failure costs only that entry's host, so it is logged.
    if (job.status === "ready" && next.accountId) {
      await setAccountAnalysisHost(deps.store, next.accountId, next.id, analysisHost(next), accountListTtl(deps.config)).catch((e: unknown) => {
        console.error("Account analysis host failed:", e instanceof Error ? e.name : "unknown error");
      });
    }
  }
  if (joinedTo) return { status: "crawling", step: "joined", analysis: current };
  return { ...viewOfJob(job, deps.config, now), analysis: current };
}

function viewOfJob(job: CrawlJob, config: Config, now: number): Omit<AnalysisView, "analysis"> {
  switch (job.status) {
    case "ready":
      return { status: "ready", step: "ready" };
    case "crawling":
      return { status: "crawling", step: job.step };
    case "queued":
      if (isQueueExpired(job, config, now)) {
        return { status: "failed", step: "failed", failure: { code: "queue_expired", message: visitorTexts.queueExpired } };
      }
      return { status: "queued", step: "queued" };
    case "failed":
      return { status: "failed", step: "failed", failure: failureView(job.failure) };
    default:
      // A join chain longer than resolveJob follows.
      return { status: "failed", step: "failed", failure: failureView(undefined) };
  }
}

/** A ready analysis: the copied snapshot and score, and when the read was ready. */
export type ReadyAnalysis<R = unknown> = Analysis<R> & Required<Pick<Analysis<R>, "snapshot" | "score" | "readyAt">>;

/** The analysis of a ready view, with its copied snapshot and score; null when it is not ready. */
export function readyAnalysis<R>(view: AnalysisView<R>): ReadyAnalysis<R> | null {
  const { snapshot, score, readyAt } = view.analysis;
  if (view.status !== "ready" || snapshot === undefined || score === undefined || readyAt === undefined) return null;
  return { ...view.analysis, snapshot, score, readyAt };
}

/** When a read that was ready at `readyAt` stops being reused (ms): a later analysis reads the site again. */
export const cachedUntil = (readyAt: number, config: Pick<Config, "crawlCacheTtlS">): number => readyAt + config.crawlCacheTtlS * 1000;

/** The contract's ScoreReport body: `status` first, the stored score fields, and `cachedUntil`. */
export function reportBody(score: unknown, readyAt: number, config: Pick<Config, "crawlCacheTtlS">): Record<string, unknown> {
  return { status: "ready", ...(score as Record<string, unknown>), cachedUntil: new Date(cachedUntil(readyAt, config)).toISOString() };
}
