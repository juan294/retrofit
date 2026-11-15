import { getConfig } from "@/lib/config";
import { setFixtureClockOffset } from "@/lib/test-fixtures/clock";

export const dynamic = "force-dynamic";

/** Fixtures mode only (404 otherwise): POST {"offsetMs": n} moves the server clock for e2e tests. */
export async function POST(request: Request): Promise<Response> {
  if (!getConfig().fixturesEnabled) return new Response("Not found", { status: 404 });
  const body = (await request.json().catch(() => null)) as { offsetMs?: unknown } | null;
  if (typeof body?.offsetMs !== "number" || !Number.isFinite(body.offsetMs)) return new Response("offsetMs required", { status: 400 });
  setFixtureClockOffset(body.offsetMs);
  return Response.json({ offsetMs: body.offsetMs });
}
