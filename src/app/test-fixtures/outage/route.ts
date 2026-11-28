import { getConfig } from "@/lib/config";
import { setFixtureOutage } from "@/lib/test-fixtures/outage";

export const dynamic = "force-dynamic";

/** Fixtures mode only (404 otherwise): POST {"on": true | false} turns the account data outage on or off. */
export async function POST(request: Request): Promise<Response> {
  if (!getConfig().fixturesEnabled) return new Response("Not found", { status: 404 });
  const body = (await request.json().catch(() => null)) as { on?: unknown } | null;
  if (typeof body?.on !== "boolean") return new Response("on required", { status: 400 });
  setFixtureOutage(body.on);
  return Response.json({ on: body.on });
}
