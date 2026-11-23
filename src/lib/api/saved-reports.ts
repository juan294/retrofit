import { findOwnedAnalysis, requesterOf } from "@/lib/analysis/owner";
import { analysisHost, isAnalysisId, readAnalysisView, readyAnalysis, reportBody } from "@/lib/analysis/record";
import { isSameOrigin } from "@/lib/analysis/run";
import type { ServerDeps } from "@/lib/server/runtime";
import { SAVE_REPORT_TEXT } from "@/lib/site/account-texts";
import { readSmallBody } from "./body";
import { refuseFeature } from "./entitled";
import { json } from "./json";

function analysisIdFrom(text: string): string | null {
  try {
    const body = JSON.parse(text) as { analysisId?: unknown } | null;
    return typeof body?.analysisId === "string" && isAnalysisId(body.analysisId) ? body.analysisId : null;
  } catch {
    return null;
  }
}

/**
 * POST /api/account/reports `{analysisId}` -> 200 `{id, message, href}`: "Save this report" on a
 * results page. Same-origin only (403). The visitor must be signed in (401 signed_out) and own the
 * analysis (its visitor cookie or attached account; else 404 not_found). The ready report (the
 * contract's ScoreReport, as `?include=result` returns it) is copied to the account's saved
 * reports, so it outlives the analysis; saving it again answers the first copy with the
 * already-saved text. 403 plan_required or 503 billing_unavailable (entitled.ts), 409 not_ready before the score exists, 409 full past MAX_SAVED_REPORTS;
 * 503 unavailable.
 */
export async function handleSaveReport(request: Request, deps: Pick<ServerDeps, "config" | "store" | "accounts" | "clock">): Promise<Response> {
  if (!isSameOrigin(request, deps.config)) return json(403, { error: "cross_origin", message: SAVE_REPORT_TEXT.crossOrigin });
  try {
    const text = await readSmallBody(request);
    const id = (text === "too large" ? null : analysisIdFrom(text)) ?? "";
    const { analysis, account } = await findOwnedAnalysis(id, requesterOf(request), deps);
    if (!account) return json(401, { error: "signed_out", message: SAVE_REPORT_TEXT.signedOut });
    if (!analysis) return json(404, { error: "not_found", message: SAVE_REPORT_TEXT.notFound });
    const refused = await refuseFeature(deps, account.accountId, "saved_reports");
    if (refused) return refused;
    const a = readyAnalysis(await readAnalysisView(deps, analysis));
    if (!a) return json(409, { error: "not_ready", message: SAVE_REPORT_TEXT.notReady });
    const report = reportBody(a.score, a.readyAt, deps.config);
    // The scored host: what the report itself names (score.host is the snapshot's host).
    const host = analysisHost(a);
    const fetchedAt = typeof report.fetchedAt === "string" ? report.fetchedAt : new Date(a.readyAt).toISOString();
    const saved = await deps.accounts.saveReport(account.accountId, { host, report, fetchedAt });
    if (saved.outcome === "full") return json(409, { error: "full", message: SAVE_REPORT_TEXT.full });
    const message = saved.outcome === "created" ? SAVE_REPORT_TEXT.saved : SAVE_REPORT_TEXT.alreadySaved;
    return json(200, { id: saved.report.id, message, href: `/account/reports/${saved.report.id}` });
  } catch (e) {
    console.error("POST /api/account/reports failed:", e instanceof Error ? e.name : "unknown error");
    return json(503, { error: "unavailable", message: SAVE_REPORT_TEXT.unavailable });
  }
}
