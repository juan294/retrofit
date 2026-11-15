import { handleAnalysisStatus } from "@/lib/api/status";
import { getServerDeps } from "@/lib/server/runtime";
import { countReads } from "@/lib/store/counting";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  const deps = getServerDeps();
  if (!deps.config.fixturesEnabled) return handleAnalysisStatus(request, deps, id);
  // Fixtures mode only: report how many analysis and job reads this request made (performance budget test).
  const counted = countReads(deps.store, (key) => key.startsWith("analysis:") || key.startsWith("crawl-job:"));
  const response = await handleAnalysisStatus(request, { ...deps, store: counted.store }, id, deps);
  response.headers.set("x-retrofit-store-reads", String(counted.reads()));
  return response;
}
