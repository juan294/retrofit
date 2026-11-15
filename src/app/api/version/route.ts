import { handleVersion } from "@/lib/api/version";

export const dynamic = "force-dynamic";

export function GET(): Response {
  return handleVersion();
}
