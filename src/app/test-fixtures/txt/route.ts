import { getConfig } from "@/lib/config";
import { setFixtureTxt } from "@/lib/test-fixtures/txt";

export const dynamic = "force-dynamic";

const isRecords = (v: unknown): v is string[][] => Array.isArray(v) && v.length <= 20 && v.every((r) => Array.isArray(r) && r.length <= 10 && r.every((c) => typeof c === "string" && c.length <= 255));

/** Fixtures mode only (404 otherwise): POST {"name": "_retrofit-verification.<host>", "records": [["chunk", ...], ...]} sets the TXT records browser tests read. */
export async function POST(request: Request): Promise<Response> {
  if (!getConfig().fixturesEnabled) return new Response("Not found", { status: 404 });
  const body = (await request.json().catch(() => null)) as { name?: unknown; records?: unknown } | null;
  if (typeof body?.name !== "string" || body.name.length > 253 || !isRecords(body.records)) return new Response("name and records required", { status: 400 });
  setFixtureTxt(body.name, body.records);
  return Response.json({ name: body.name, records: body.records.length });
}
