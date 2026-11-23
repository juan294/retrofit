import { handleBillingWebhook } from "@/lib/api/billing-webhook";
import { getServerDeps } from "@/lib/server/runtime";

export const dynamic = "force-dynamic";

export function POST(request: Request): Promise<Response> {
  return handleBillingWebhook(request, getServerDeps());
}
