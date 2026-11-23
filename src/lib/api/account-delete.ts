import { deleteAccount } from "@/lib/accounts/delete";
import { signInHref } from "@/lib/accounts/return-to";
import { accountClearCookie, readAccount } from "@/lib/accounts/session";
import { isSameOrigin } from "@/lib/analysis/run";
import { isSecureRequest } from "@/lib/analysis/visitor";
import type { ServerDeps } from "@/lib/server/runtime";
import { ACCOUNT_TEXT } from "@/lib/site/account-texts";
import { readSmallBody } from "./body";
import { json, seeOther } from "./json";

/**
 * POST /api/account/delete (the account page's form, urlencoded `confirm=yes`) -> 303.
 * Same-origin only (403). Signed out -> /sign-in?returnTo=/account. Without the ticked box ->
 * /account?delete=confirm. Deleted -> /sign-in?account=deleted with the cookie cleared. A failure ->
 * /account?delete=failed (nothing deleted) or ?delete=partial, and the visitor stays signed in.
 */
export async function handleAccountDelete(request: Request, deps: Pick<ServerDeps, "config" | "store" | "accounts" | "auth" | "clock">): Promise<Response> {
  if (!isSameOrigin(request, deps.config)) return json(403, { error: "cross_origin", message: ACCOUNT_TEXT.crossOrigin });
  let account;
  try {
    account = await readAccount(request, deps);
  } catch (e) {
    console.error("POST /api/account/delete failed:", e instanceof Error ? e.name : "unknown error");
    return seeOther(deps, "/account?delete=failed");
  }
  if (!account) return seeOther(deps, signInHref("/account"));
  const text = await readSmallBody(request);
  const confirmed = text !== "too large" && new URLSearchParams(text).get("confirm") === "yes";
  if (!confirmed) return seeOther(deps, "/account?delete=confirm");

  const outcome = await deleteAccount(deps, account);
  if (outcome === "deleted") return seeOther(deps, "/sign-in?account=deleted", [accountClearCookie(isSecureRequest(request, deps.config))]);
  return seeOther(deps, `/account?delete=${outcome === "partial" ? "partial" : "failed"}`);
}
