import { getConfig } from "@/lib/config";
import { llmsText } from "@/lib/site/own-site";

export const dynamic = "force-dynamic";

export function GET(): Response {
  return new Response(llmsText(getConfig().publicOrigin), { headers: { "content-type": "text/plain; charset=utf-8" } });
}
