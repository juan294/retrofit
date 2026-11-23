import { dispatchQueued } from "@/lib/analysis/capacity";
import { isSameOrigin, startAnalysis } from "@/lib/analysis/run";
import { visitorTexts } from "@/lib/analysis/texts";
import { resolveVisitor } from "@/lib/analysis/visitor";
import { readAccount } from "@/lib/accounts/session";
import { clientIdFromRequest } from "@/lib/fetch/limits";
import type { ServerDeps } from "@/lib/server/runtime";
import { readLimitedBody } from "./body";
import { json } from "./json";

export const MAX_BODY_BYTES = 8192;

const tooLarge = () => json(413, { error: "too_large", message: visitorTexts.tooLarge });

function urlFrom(text: string): string | null {
  try {
    const body = JSON.parse(text) as { url?: unknown } | null;
    return typeof body?.url === "string" ? body.url : null;
  } catch {
    return null;
  }
}

/**
 * POST /api/analyze `{url}` -> 200 `{id}`. Same-origin only (403 otherwise).
 * Sets the visitor cookie when absent. A signed-in visitor's analysis is attached to the account. Errors: 400 not_public, 413 too_large,
 * 429 client_limit or daily_limit (`{error, message, retryAt?}`), 503 unavailable,
 * and 503 counting (`{error, message, retryAfterSeconds}` with Retry-After) while
 * the site's daily count is undecided: no analysis is created, so the page retries.
 * Every request, including the early returns, dispatches queued work.
 */
export async function handleAnalyze(request: Request, deps: ServerDeps): Promise<Response> {
  const invocation = { startedAt: deps.clock() };
  deps.waitUntil(dispatchQueued(deps, invocation));
  if (!isSameOrigin(request, deps.config)) return json(403, { error: "cross_origin", message: visitorTexts.crossOrigin });
  const visitor = resolveVisitor(request, deps.config);
  try {
    const text = await readLimitedBody(request, MAX_BODY_BYTES);
    if (text === "too large") return tooLarge();
    const rawUrl = urlFrom(text);
    if (rawUrl === null) return json(400, { error: "not_public", message: visitorTexts.notPublic }, visitor.setCookie);
    const clientId = clientIdFromRequest(request, deps.config, deps.clock());
    // readAccount reads nothing without an account cookie, so the anonymous path is unchanged.
    const account = await readAccount(request, deps);
    const outcome = await startAnalysis(deps, { rawUrl, ownerHash: visitor.hash, clientId, invocation, accountId: account?.accountId });
    if (outcome.ok) return json(200, { id: outcome.id }, visitor.setCookie);
    if (outcome.code === "counting") {
      const { status, code, message, retryAfterSeconds } = outcome;
      const res = json(status, { error: code, message, retryAfterSeconds }, visitor.setCookie);
      res.headers.set("retry-after", String(retryAfterSeconds));
      return res;
    }
    const { status, code, message, retryAt } = outcome;
    return json(status, { error: code, message, ...(retryAt ? { retryAt } : {}) }, visitor.setCookie);
  } catch (e) {
    console.error("POST /api/analyze failed:", e instanceof Error ? e.message : String(e));
    return json(503, { error: "unavailable", message: visitorTexts.unavailable }, visitor.setCookie);
  }
}
