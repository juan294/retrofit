import { getAuthGateway, getConfig } from "@/lib/server/runtime";
import type { FixtureAuth } from "@/lib/test-fixtures/auth";

export const dynamic = "force-dynamic";

/**
 * Fixtures mode only (404 otherwise): GET ?email=<address> -> `{link}`, the newest sign-in link the
 * fixture provider "emailed" to that address, so browser tests can sign in. 404 when none was sent.
 */
export function GET(request: Request): Response {
  const config = getConfig();
  if (!config.fixturesEnabled) return new Response("Not found", { status: 404 });
  const email = new URL(request.url).searchParams.get("email") ?? "";
  const link = (getAuthGateway(config) as FixtureAuth).latestLink(email);
  if (!link) return Response.json({ error: "no_mail" }, { status: 404, headers: { "cache-control": "no-store" } });
  return Response.json({ link }, { headers: { "cache-control": "no-store" } });
}
