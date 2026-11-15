import { dispatchQueued } from "@/lib/analysis/capacity";
import { getAnalysis, isAnalysisId, readAnalysisView, reportBody, type AnalysisView } from "@/lib/analysis/record";
import { visitorTexts } from "@/lib/analysis/texts";
import { hashVisitor, readVisitorToken, sameHash } from "@/lib/analysis/visitor";
import type { ServerDeps } from "@/lib/server/runtime";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

const notFound = () => json(404, { error: "not_found", message: visitorTexts.otherBrowser });

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
 * must equal the analysis's ownerHash; otherwise, and for an id that does not
 * exist, 404 with the "belongs to another browser" text. One store read for
 * the analysis and at most one for its job.
 *
 * `?include=result` answers `{...compact status, report}`, where `report` is
 * the contract's ScoreReport (with `status` and `cachedUntil`) once ready,
 * else null.
 */
export async function handleAnalysisStatus(request: Request, deps: ServerDeps, id: string, dispatchDeps: ServerDeps = deps): Promise<Response> {
  dispatchDeps.waitUntil(dispatchQueued(dispatchDeps));
  const token = readVisitorToken(request);
  if (!token || !isAnalysisId(id)) return notFound();
  try {
    const analysis = await getAnalysis(deps.store, id);
    if (!analysis || !sameHash(analysis.ownerHash, hashVisitor(token))) return notFound();
    const view = await readAnalysisView(deps, analysis);
    const body = compact(view);
    if (new URL(request.url).searchParams.get("include") !== "result") return json(200, body);
    const a = view.analysis;
    const report = body.scoreReady && a.readyAt !== undefined ? reportBody(a.score, a.readyAt, deps.config) : null;
    return json(200, { ...body, report });
  } catch (e) {
    console.error("GET /api/analyze/[id] failed:", e instanceof Error ? e.message : String(e));
    return json(503, { error: "unavailable", message: visitorTexts.unavailable });
  }
}
