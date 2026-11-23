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
