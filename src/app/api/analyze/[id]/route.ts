import { handleAnalysisStatus } from "@/lib/api/status";
import { getServerDeps } from "@/lib/server/runtime";
import { countReads, type StoreWork } from "@/lib/store/counting";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  const deps = getServerDeps();
  if (!deps.config.fixturesEnabled) return handleAnalysisStatus(request, deps, id);
  // Fixtures mode only (performance budget test): count this request's store work, in the
  // foreground and in the background dispatch it starts. The response waits for that dispatch
  // (not for the crawls it starts), so the count is complete and the latency includes it.
  const foreground = countReads(deps.store, (key) => key.startsWith("analysis:") || key.startsWith("crawl-job:"));
  const background = countReads(deps.store);
  let dispatch: Promise<number> | undefined;
  const response = await handleAnalysisStatus(request, { ...deps, store: foreground.store }, id, {
    dispatchDeps: { ...deps, store: background.store },
    onDispatch: (p) => void (dispatch = p),
  });
  let work: StoreWork = { foreground: foreground.operations(), dispatch: null };
  if (dispatch) {
    const started = await dispatch.catch(() => null);
    // A failed dispatch reports null, which fails the oracle instead of reading as zero.
    if (started !== null) work = { ...work, dispatch: { started, operations: background.operations(), claims: background.byOperation().claimWithLease ?? 0 } };
  }
  response.headers.set("x-retrofit-store-reads", String(foreground.reads()));
  response.headers.set("x-retrofit-store-work", JSON.stringify(work));
  return response;
}
