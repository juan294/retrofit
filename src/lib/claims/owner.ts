import type { ServerDeps } from "@/lib/server/runtime";
import { claimHost } from "./host";

/**
 * The scored hosts of `hosts` for which the account's claim is verified now (an exact host each). An outage
 * of the account data answers none: the caller then gives what every visitor gets.
 */
export async function ownedOf(deps: Pick<ServerDeps, "accounts">, accountId: string, hosts: readonly string[]): Promise<string[]> {
  try {
    const verified = new Set((await deps.accounts.listClaims(accountId)).filter((c) => c.status === "verified").map((c) => c.host));
    return hosts.filter((h) => verified.has(claimHost(h) ?? ""));
  } catch (e) {
    console.error("Reading the claims of an analysis start failed:", e instanceof Error ? e.name : "unknown error");
    return [];
  }
}
