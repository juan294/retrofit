import { hashToken, TOKEN_PATTERN, type AccountData } from "@/lib/accounts/data";

/** `done`: the address is unsubscribed (now or earlier). `invalid`: no signup has this link. `unavailable`: try later. */
export type UnsubscribeOutcome = "done" | "invalid" | "unavailable";

/**
 * GET /unsubscribe?t=<token>: records the unsubscribe time once. A second visit
 * answers `done` again and changes nothing. A missing, malformed or unknown
 * token answers `invalid` and reveals no address. The token is never logged.
 */
export async function unsubscribeByToken(t: string | string[] | undefined, accounts: AccountData): Promise<UnsubscribeOutcome> {
  if (typeof t !== "string" || !TOKEN_PATTERN.test(t)) return "invalid";
  try {
    return (await accounts.unsubscribe(hashToken(t))) === "unknown" ? "invalid" : "done";
  } catch (e) {
    console.error("GET /unsubscribe failed:", e instanceof Error ? e.name : "unknown error");
    return "unavailable";
  }
}
