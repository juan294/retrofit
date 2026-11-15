import { getConfig } from "@/lib/config";
import { peerFile } from "@/lib/peer/files";

export const dynamic = "force-dynamic";

/**
 * The synthetic peer site Harbor tours demo (peers/demo-harbor/public/). src/proxy.ts
 * rewrites every request for the peer host here (src/lib/peer/host.ts peerHostRewrite).
 * The Host header is checked again, so the main host answers 404 for /peer/* paths.
 */
export async function GET(request: Request, { params }: { params: Promise<{ path: string[] }> }): Promise<Response> {
  const { path } = await params;
  const file = peerFile(request.headers.get("host") ?? "", `/${path.join("/")}`, getConfig());
  if (!file) return new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
  return new Response(file.body, { status: file.status, headers: file.headers });
}
