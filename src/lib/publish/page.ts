import type { PublicReport } from "@/lib/accounts/data";
import type { ServerDeps } from "@/lib/server/runtime";
import { exactHost } from "./host";

/** What /s/<host> shows: the public report, or null when the host is not public or not in its exact form. One read. Throws when the account data is unavailable. */
export async function readPublishedPage(deps: Pick<ServerDeps, "accounts">, rawHost: string): Promise<PublicReport | null> {
  const host = exactHost(rawHost);
  return host === null ? null : deps.accounts.getPublicReport(host);
}
