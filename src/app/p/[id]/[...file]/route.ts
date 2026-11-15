import { handlePreviewFile } from "@/lib/preview/artifacts";
import { getServerDeps } from "@/lib/server/runtime";

export const dynamic = "force-dynamic";

/** The private preview's artifacts (src/lib/preview/artifacts.ts). */
export async function GET(request: Request, { params }: { params: Promise<{ id: string; file: string[] }> }): Promise<Response> {
  const { id, file } = await params;
  return handlePreviewFile(request, getServerDeps(), id, file);
}
