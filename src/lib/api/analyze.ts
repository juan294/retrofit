import { isSameOrigin, startAnalysis } from "@/lib/analysis/run";
import { visitorTexts } from "@/lib/analysis/texts";
import { resolveVisitor } from "@/lib/analysis/visitor";
import { clientIdFromRequest } from "@/lib/fetch/limits";
import type { ServerDeps } from "@/lib/server/runtime";

const MAX_BODY_BYTES = 4096;

function json(status: number, body: unknown, setCookie: string | null = null): Response {
  const headers = new Headers({ "content-type": "application/json", "cache-control": "no-store" });
  if (setCookie) headers.set("set-cookie", setCookie);
  return new Response(JSON.stringify(body), { status, headers });
}

async function readUrl(request: Request): Promise<string | null> {
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return null;
  try {
    const body = JSON.parse(text) as { url?: unknown } | null;
    return typeof body?.url === "string" ? body.url : null;
  } catch {
    return null;
  }
}

/**
 * POST /api/analyze `{url}` -> 200 `{id}`. Same-origin only (403 otherwise).
 * Sets the visitor cookie when absent. Errors: 400 not_public, 429 client_limit
 * or daily_limit (`{error, message, retryAt?}`), 503 unavailable.
 */
export async function handleAnalyze(request: Request, deps: ServerDeps): Promise<Response> {
  if (!isSameOrigin(request, deps.config)) return json(403, { error: "cross_origin", message: visitorTexts.crossOrigin });
  const visitor = resolveVisitor(request, deps.config);
  try {
    const rawUrl = await readUrl(request);
    if (rawUrl === null) return json(400, { error: "not_public", message: visitorTexts.notPublic }, visitor.setCookie);
    const clientId = clientIdFromRequest(request, deps.config, deps.clock());
    const outcome = await startAnalysis(deps, { rawUrl, ownerHash: visitor.hash, clientId });
    if (outcome.ok) return json(200, { id: outcome.id }, visitor.setCookie);
    const { status, code, message, retryAt } = outcome;
    return json(status, { error: code, message, ...(retryAt ? { retryAt } : {}) }, visitor.setCookie);
  } catch (e) {
    console.error("POST /api/analyze failed:", e instanceof Error ? e.message : String(e));
    return json(503, { error: "unavailable", message: visitorTexts.unavailable }, visitor.setCookie);
  }
}
