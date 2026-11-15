/** A JSON response that is never cached, optionally setting the visitor cookie. */
export function json(status: number, body: unknown, setCookie: string | null = null): Response {
  const headers = new Headers({ "content-type": "application/json", "cache-control": "no-store" });
  if (setCookie) headers.set("set-cookie", setCookie);
  return new Response(JSON.stringify(body), { status, headers });
}
