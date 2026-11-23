import { getFixtureAuth } from "@/lib/server/runtime";

export const dynamic = "force-dynamic";

/**
 * Fixtures mode only (404 otherwise): GET ?email=<address> -> `{link}`, the newest sign-in link the
 * fixture provider "emailed" to that address, so browser tests can sign in. 404 when none was sent.
 */
export function GET(request: Request): Response {
  const fixture = getFixtureAuth();
  if (!fixture) return new Response("Not found", { status: 404 });
  const link = fixture.latestLink(new URL(request.url).searchParams.get("email") ?? "");
  if (!link) return Response.json({ error: "no_mail" }, { status: 404, headers: { "cache-control": "no-store" } });
  return Response.json({ link }, { headers: { "cache-control": "no-store" } });
}
