import type { ServerDeps } from "@/lib/server/runtime";
import { claimHost } from "./host";

/**
 * True when the account's claim for exactly this scored host is verified now. An outage of the account
 * data answers false: the caller then gives what every visitor gets.
 */
export async function ownsHost(deps: Pick<ServerDeps, "accounts">, accountId: string, scoredHost: string): Promise<boolean> {
  const host = claimHost(scoredHost);
  if (host === null) return false;
  try {
    return (await deps.accounts.listClaims(accountId)).some((c) => c.host === host && c.status === "verified");
  } catch (e) {
    console.error("Reading the claims of an analysis start failed:", e instanceof Error ? e.name : "unknown error");
    return false;
  }
}
