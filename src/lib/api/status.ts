import { dispatchQueued } from "@/lib/analysis/capacity";
import { getAnalysis, isAnalysisId, readAnalysisView, reportBody, type AnalysisView } from "@/lib/analysis/record";
import { visitorTexts } from "@/lib/analysis/texts";
import { ownsAnalysis, requesterOf } from "@/lib/analysis/owner";
import type { ServerDeps } from "@/lib/server/runtime";
import { generateNetwork, GenerationFailed } from "@/lib/generate/network";
import type { Snapshot } from "@/lib/snapshot/types";
import { json } from "./json";

const notFound = () => json(404, { error: "not_found", message: visitorTexts.otherBrowser });

function canInstall(snapshot: Snapshot | undefined): boolean {
  if (!snapshot) return false;
  try {
    generateNetwork({ snapshot, target: "bundle" });
    return true;
  } catch (error) {
    if (error instanceof GenerationFailed) return false;
    throw error;
  }
}

/** The compact status: `{status, step, failure?, scoreReady}`, at most 2 KB. */
export interface StatusBody {
  readonly status: AnalysisView["status"];
  readonly step: string;
  readonly failure?: AnalysisView["failure"];
  readonly scoreReady: boolean;
}

const MAX_STEP_CHARS = 80;

function compact(view: AnalysisView): StatusBody {
  return {
    status: view.status,
    step: view.step.slice(0, MAX_STEP_CHARS),
    ...(view.failure ? { failure: view.failure } : {}),
    scoreReady: view.status === "ready" && view.analysis.score !== undefined,
  };
}

/**
 * GET /api/analyze/[id] (and `?include=result`). The visitor cookie's hash
 * must equal the analysis's ownerHash, or the signed-in account must be the one
 * the analysis is attached to (owner.ts); otherwise, and for an id that does not
 * exist, 404 with the "belongs to another browser" text. One store read for
 * the analysis and at most one for its job. The owner's request also
 * dispatches queued crawls in the background.
 *
 * `?include=result` answers `{...compact status, report}`, where `report` is
 * the contract's ScoreReport (with `status` and `cachedUntil`) once ready,
 * else null.
 */
export interface StatusMeasurement {
  /** Deps for the dispatch this request starts (fixtures mode wraps their store to count it). */
  readonly dispatchDeps: ServerDeps;
  /** Receives the dispatch promise (resolves to the number of workers started), so its store work can be awaited and counted. */
  onDispatch(dispatch: Promise<number>): void;
}

export async function handleAnalysisStatus(request: Request, deps: ServerDeps, id: string, measure?: StatusMeasurement): Promise<Response> {
  const who = requesterOf(request);
  if ((!who.visitorToken && !who.accountToken) || !isAnalysisId(id)) return notFound();
  try {
    const analysis = await getAnalysis(deps.store, id);
    if (!analysis || !(await ownsAnalysis(analysis, who, deps))) return notFound();
    // Only the owner's poll moves the queue: a request without the cookie, with an invalid id or for
    // another visitor's analysis starts no store work beyond that one read.
    const dispatchDeps = measure?.dispatchDeps ?? deps;
    const dispatch = dispatchQueued(dispatchDeps, { startedAt: dispatchDeps.clock() });
    dispatchDeps.waitUntil(dispatch);
    measure?.onDispatch(dispatch);
    const view = await readAnalysisView(deps, analysis);
    const body = compact(view);
    if (new URL(request.url).searchParams.get("include") !== "result") return json(200, body);
    const a = view.analysis;
    const report = body.scoreReady && a.readyAt !== undefined ? reportBody(a.score, a.readyAt, deps.config) : null;
    return json(200, { ...body, report, bundleReady: Boolean(report) && canInstall(a.snapshot) });
  } catch (e) {
    console.error("GET /api/analyze/[id] failed:", e instanceof Error ? e.message : String(e));
    return json(503, { error: "unavailable", message: visitorTexts.unavailable });
  }
}
