import { handleCheckout } from "@/lib/api/billing";
import { getServerDeps } from "@/lib/server/runtime";

export const dynamic = "force-dynamic";

export function POST(request: Request): Promise<Response> {
  return handleCheckout(request, getServerDeps());
}
