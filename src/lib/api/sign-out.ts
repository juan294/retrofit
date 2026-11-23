import { accountClearCookie, endAccountSession, readAccount } from "@/lib/accounts/session";
import { isSameOrigin } from "@/lib/analysis/run";
import { isSecureRequest } from "@/lib/analysis/visitor";
import type { ServerDeps } from "@/lib/server/runtime";
import { SIGN_IN_TEXT } from "@/lib/site/sign-in-texts";
import { json } from "./json";

/** A 303 to a same-origin path, never cached. */
export function seeOther(deps: Pick<ServerDeps, "config">, path: string, setCookies: readonly string[] = []): Response {
  const headers = new Headers({ location: `${deps.config.publicOrigin}${path}`, "cache-control": "no-store" });
  for (const c of setCookies) headers.append("set-cookie", c);
  return new Response(null, { status: 303, headers });
}

/**
 * POST /api/auth/sign-out (the account page's form) -> 303 to the home page. Same-origin only (403).
 * Deletes this session's Store record and clears the cookie. When the Store fails, the cookie is
 * still cleared, so the browser is signed out; the record then expires on its own.
 */
export async function handleSignOut(request: Request, deps: Pick<ServerDeps, "config" | "store" | "clock">): Promise<Response> {
  if (!isSameOrigin(request, deps.config)) return json(403, { error: "cross_origin", message: SIGN_IN_TEXT.crossOrigin });
  try {
    const account = await readAccount(request, deps);
    if (account) await endAccountSession(deps.store, account);
  } catch (e) {
    console.error("POST /api/auth/sign-out failed:", e instanceof Error ? e.name : "unknown error");
  }
  return seeOther(deps, "/", [accountClearCookie(isSecureRequest(request, deps.config))]);
}
