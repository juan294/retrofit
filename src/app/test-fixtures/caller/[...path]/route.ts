import { getConfig } from "@/lib/config";
import { callerArtifact } from "@/lib/test-fixtures/caller";

export const dynamic = "force-dynamic";

/**
 * Test-only caller artifacts (src/lib/test-fixtures/caller.ts). src/proxy.ts rewrites
 * requests for the caller hosts here in fixtures mode; the Host header picks the caller.
 * 404 unless fixtures are enabled.
 */
export async function GET(request: Request, { params }: { params: Promise<{ path: string[] }> }): Promise<Response> {
  const { path } = await params;
  const host = request.headers.get("host") ?? "";
  const artifact = callerArtifact(host, `/${path.join("/")}`, getConfig());
  if (!artifact) return new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
  return new Response(artifact.body, { status: artifact.status, headers: artifact.headers });
}
