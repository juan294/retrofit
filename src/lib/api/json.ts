import type { LimitResult } from "@/lib/fetch/limits";

/** A JSON response that is never cached, optionally setting the visitor cookie. */
export function json(status: number, body: unknown, setCookie: string | null = null): Response {
  const headers = new Headers({ "content-type": "application/json", "cache-control": "no-store" });
  if (setCookie) headers.set("set-cookie", setCookie);
  return new Response(JSON.stringify(body), { status, headers });
}

/** A 303 to a same-origin path (PUBLIC_ORIGIN + `path`), never cached, with any Set-Cookie values and extra headers. */
export function seeOther(deps: { readonly config: { readonly publicOrigin: string } }, path: string, setCookies: readonly string[] = [], extraHeaders: Record<string, string> = {}): Response {
  const headers = new Headers({ location: `${deps.config.publicOrigin}${path}`, "cache-control": "no-store", ...extraHeaders });
  for (const c of setCookies) headers.append("set-cookie", c);
  return new Response(null, { status: 303, headers });
}

/** Null when the window admitted the call; otherwise 429 `{error: "limit", message, retryAt}` with the text for the window's end. */
export function limitOr429(counted: LimitResult, text: (retryAt: Date) => string): Response | null {
  if (counted.ok) return null;
  const retryAt = new Date(counted.retryAt);
  return json(429, { error: "limit", message: text(retryAt), retryAt: retryAt.toISOString() });
}
