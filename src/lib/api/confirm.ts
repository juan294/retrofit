import { DEFAULT_RETURN } from "@/lib/accounts/return-to";
import { accountSetCookie, createAccountSession, readAccount } from "@/lib/accounts/session";
import { attachVisitorAnalyses } from "@/lib/analysis/owner";
import { isSameOrigin } from "@/lib/analysis/run";
import { isSecureRequest, readVisitorToken, visitorSetCookie } from "@/lib/analysis/visitor";
import { AuthUnavailable, type VerifiedAccount } from "@/lib/auth/gateway";
import { clientIdFromRequest, countClientWindow } from "@/lib/fetch/limits";
import { cookieValue } from "@/lib/security/cookies";
import { newToken, sha256Hex } from "@/lib/security/tokens";
import type { ServerDeps } from "@/lib/server/runtime";
import { SIGN_IN_TEXT } from "@/lib/site/sign-in-texts";
import { readSmallBody } from "./body";
import { json, seeOther } from "./json";
import { clearPendingCookie, clearSignInCookie, pendingCookieName, rememberBrowser, signInCookieName, startPending, takePending, takeSignInIntent, type SignInIntent } from "./sign-in";

/** Supabase email token hashes are hex; anything else is refused before the provider is asked. */
const TOKEN_HASH = /^[0-9a-f]{16,128}$/i;

/** The form posts `type=email` (the only type Retrofit's links carry). `address`: a verified sign-in waits for Continue. */
export type ConfirmPageState = { readonly kind: "confirm"; readonly tokenHash: string } | { readonly kind: "address" } | { readonly kind: "invalid" };

/**
 * What GET /auth/confirm shows. It calls no provider and sets no cookie: mail scanners open every
 * link, so the link is verified only when the visitor posts the page's form.
 */
export function confirmPageState(params: Record<string, string | string[] | undefined>): ConfirmPageState {
  const { token_hash: tokenHash, type, step } = params;
  if (step === "address") return { kind: "address" };
  if (type !== "email" || typeof tokenHash !== "string" || !TOKEN_HASH.test(tokenHash)) return { kind: "invalid" };
  return { kind: "confirm", tokenHash };
}

/** No account has this id. */
const NO_ACCOUNT = "00000000-0000-4000-8000-000000000000";

const redirect = (deps: Pick<ServerDeps, "config">, path: string, cookies: readonly string[] = []) => seeOther(deps, path, cookies, { "referrer-policy": "no-referrer" });

/**
 * POST /auth/verify `token_hash=<hash>&type=email` (urlencoded): the "Sign in" button of the page the
 * emailed link opens (/auth/confirm, confirmPageState). Same-origin only (403), so another site
 * cannot post a link to sign a visitor in.
 *
 * 1. Validates the fields, counts the network's link checks (the provider sees every visitor from Retrofit's
 *    own addresses, so its limit is shared), and verifies the token once with the provider (server side).
 * 2. When this browser did not ask for a link for the verified address (the sign-in cookie), nothing is
 *    signed in: the verified account waits for this browser (startPending), and the page names its
 *    address. A link that somebody else sent cannot sign a visitor in to their account unseen. That
 *    page's forms post `continue=yes` (then step 3 and /account) or `cancel=yes` (the wait ends), with
 *    `pending`: the waiting sign-in whose address was shown, so no other one is taken.
 * 3. Ends the browser's current account session, if any, then creates the account profile when absent
 *    and a new Retrofit session (the account cookie), and remembers the browser (its visitor cookie,
 *    created when absent) for the sign-in limits.
 * 4. When this browser asked for the link: attaches the visitor's analyses to the account and returns to
 *    the page sign-in started from.
 *
 * Every other answer is a 303 with no-store and no referrer. An expired, used, unknown or malformed link
 * (or wait) goes to /sign-in?link=expired; past the network's limit, with the link unused, to
 * /sign-in?link=busy; a provider or Store failure, or an account that is being
 * deleted, to /sign-in?link=unavailable. The provider's own tokens never leave the gateway.
 */
export async function handleConfirm(request: Request, deps: Pick<ServerDeps, "config" | "store" | "accounts" | "auth" | "clock">): Promise<Response> {
  if (!isSameOrigin(request, deps.config)) return json(403, { error: "cross_origin", message: SIGN_IN_TEXT.crossOrigin });
  const { config, store } = deps;
  const secure = isSecureRequest(request, config);
  const cookies = request.headers.get("cookie");
  const clearPending = clearPendingCookie(config, secure);
  const text = await readSmallBody(request);
  const fields = new URLSearchParams(text === "too large" ? "" : text);
  const tokenHash = fields.get("token_hash") ?? "";
  const step = fields.get("continue") === "yes" ? "continue" : fields.get("cancel") === "yes" ? "cancel" : "link";
  if (step === "link" && (fields.get("type") !== "email" || !TOKEN_HASH.test(tokenHash))) return redirect(deps, "/sign-in?link=expired");

  try {
    let account: VerifiedAccount;
    let intent: SignInIntent | null = null;
    if (step === "link") {
      const limit = await countClientWindow(store, "signin-verify", config.signInVerifyPerClientHour, clientIdFromRequest(request, config, deps.clock()), deps.clock());
      if (!limit.ok) return redirect(deps, "/sign-in?link=busy");
      // A link works once: it is not checked while the account data, which the next step needs, cannot be read.
      await deps.accounts.getProfile(NO_ACCOUNT);
      const verified = await deps.auth.verifyOtp(tokenHash, "email");
      if (!verified.ok) return redirect(deps, "/sign-in?link=expired");
      account = { userId: verified.userId, email: verified.email };
      intent = await takeSignInIntent(deps, cookieValue(cookies, signInCookieName(config)), account.email);
      if (!intent) return redirect(deps, "/auth/confirm?step=address", [await startPending(deps, account, secure)]);
    } else {
      const pending = await takePending(store, cookieValue(cookies, pendingCookieName(config)), fields.get("pending") ?? "");
      if (step === "cancel") return redirect(deps, "/", pending ? [clearPending] : []);
      if (!pending) return redirect(deps, "/sign-in?link=expired");
      account = pending;
    }

    // Independent: the browser's current session (it ends as the new one starts) and the profile.
    const [previous] = await Promise.all([readAccount(request, deps), deps.accounts.ensureProfile(account.userId)]);
    const { token } = await createAccountSession(deps, account, previous);

    const visitorToken = readVisitorToken(request);
    const browser = visitorToken ?? newToken();
    // The link is used up and the session exists: a failure here must not lose the sign-in.
    const steps = [rememberBrowser(deps, account.email, browser), ...(intent && visitorToken ? [attachVisitorAnalyses(deps, sha256Hex(visitorToken), account.userId)] : [])];
    for (const result of await Promise.allSettled(steps)) {
      if (result.status === "rejected") console.error("Finishing a sign-in failed:", result.reason instanceof Error ? result.reason.name : "unknown error");
    }
    return redirect(deps, intent?.next ?? DEFAULT_RETURN, [accountSetCookie(token, config, secure), ...(visitorToken ? [] : [visitorSetCookie(browser, secure)]), intent ? clearSignInCookie(config, secure) : clearPending]);
  } catch (e) {
    console.error("POST /auth/verify failed:", e instanceof AuthUnavailable ? `${e.name} (${e.code})` : e instanceof Error ? e.name : "unknown error");
    return redirect(deps, "/sign-in?link=unavailable");
  }
}
