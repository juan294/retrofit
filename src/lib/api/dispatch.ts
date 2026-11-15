import { timingSafeEqual } from "node:crypto";
import { dispatchQueued } from "../analysis/capacity";
import { dispatchToken, type ServerDeps } from "../server/runtime";

function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** POST /api/internal/dispatch: starts queued crawls in a fresh invocation. Bearer token from SESSION_SECRET. */
export async function handleDispatch(request: Request, deps: ServerDeps): Promise<Response> {
  const auth = request.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (request.method !== "POST" || !sameToken(token, dispatchToken(deps.config))) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  }
  const started = await dispatchQueued(deps, { startedAt: deps.clock() }).catch(() => 0);
  return new Response(JSON.stringify({ started }), { status: 202, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
