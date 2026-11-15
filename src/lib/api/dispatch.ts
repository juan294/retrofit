import { dispatchQueued } from "../analysis/capacity";
import { sameHash } from "../analysis/visitor";
import { dispatchToken, type ServerDeps } from "../server/runtime";
import { json } from "./json";

/** POST /api/internal/dispatch: starts queued crawls in a fresh invocation. Bearer token from SESSION_SECRET. */
export async function handleDispatch(request: Request, deps: ServerDeps): Promise<Response> {
  const auth = request.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (request.method !== "POST" || !sameHash(token, dispatchToken(deps.config))) {
    return json(401, { error: "unauthorized" });
  }
  const started = await dispatchQueued(deps, { startedAt: deps.clock() }).catch(() => 0);
  return json(202, { started });
}
