import { handlePublishedFile } from "@/lib/publish/files";
import { getServerDeps } from "@/lib/server/runtime";

export const dynamic = "force-dynamic";

/** A published site's agent files (src/lib/publish/files.ts). */
export async function GET(_request: Request, { params }: { params: Promise<{ host: string; file: string[] }> }): Promise<Response> {
  const { host, file } = await params;
  return handlePublishedFile(getServerDeps(), host, file);
}
