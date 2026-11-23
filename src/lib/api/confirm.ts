import { DEFAULT_RETURN } from "@/lib/accounts/return-to";
import { accountSetCookie, cookieValue, createAccountSession, endAccountSession, readAccount } from "@/lib/accounts/session";
import { attachVisitorAnalyses } from "@/lib/analysis/owner";
import { isSameOrigin } from "@/lib/analysis/run";
import { isSecureRequest, readVisitorToken, sameHash } from "@/lib/analysis/visitor";
import { AuthUnavailable } from "@/lib/auth/gateway";
import { sha256Hex } from "@/lib/security/tokens";
import type { ServerDeps } from "@/lib/server/runtime";
import { SIGN_IN_TEXT } from "@/lib/site/sign-in-texts";
import { readSmallBody } from "./body";
import { json } from "./json";
import { SIGN_IN_COOKIE, clearIntentCookie, emailKey, takeSignInIntent } from "./sign-in";

/** Supabase email token hashes are hex; anything else is refused before the provider is asked. */
const TOKEN_HASH = /^[0-9a-f]{16,128}$/i;

export type ConfirmPageState = { readonly kind: "confirm"; readonly tokenHash: string; readonly type: "email"; readonly otherBrowser: boolean } | { readonly kind: "invalid" };

/**
 * What GET /auth/confirm shows. It calls no provider and sets no cookie: mail scanners open every
 * link, so the link is verified only when the visitor posts the page's form. `hasIntent`: the
 * browser carries the retrofit_signin cookie; without it the page warns that the link was asked
 * for elsewhere (a link someone else sent would sign this browser in to their account).
 */
export function confirmPageState(params: Record<string, string | string[] | undefined>, hasIntent: boolean): ConfirmPageState {
  const { token_hash: tokenHash, type } = params;
  if (type !== "email" || typeof tokenHash !== "string" || !TOKEN_HASH.test(tokenHash)) return { kind: "invalid" };
  return { kind: "confirm", tokenHash, type, otherBrowser: !hasIntent };
}

function redirect(deps: Pick<ServerDeps, "config">, path: string, cookies: readonly string[]): Response {
  const headers = new Headers({ location: `${deps.config.publicOrigin}${path}`, "cache-control": "no-store", "referrer-policy": "no-referrer" });
  for (const c of cookies) headers.append("set-cookie", c);
  return new Response(null, { status: 303, headers });
}

/**
 * POST /auth/verify `token_hash=<hash>&type=email` (urlencoded): the "Sign in" button of the page the
 * emailed link opens (/auth/confirm, confirmPageState). Same-origin only (403), so another site
 * cannot post a link to sign a visitor in.
 *
 * 1. Validates the fields and verifies the token once with the provider (server side).
 * 2. Ends the browser's current account session, if any, then creates the account profile when
 *    absent and a new Retrofit session (the `retrofit_account` cookie).
 * 3. When this browser asked for the link for the same address (the `retrofit_signin` cookie),
 *    attaches the visitor's analyses to the account and returns to the page sign-in started
 *    from; otherwise returns to /account and attaches nothing.
 *
 * Every other answer is a 303 with no-store and no referrer, and clears `retrofit_signin`. An
 * expired, used, unknown or malformed link goes to /sign-in?link=expired; a provider or Store
 * failure to /sign-in?link=unavailable. The provider's own tokens never leave the gateway.
 */
export async function handleConfirm(request: Request, deps: Pick<ServerDeps, "config" | "store" | "accounts" | "auth" | "clock">): Promise<Response> {
  if (!isSameOrigin(request, deps.config)) return json(403, { error: "cross_origin", message: SIGN_IN_TEXT.crossOrigin });
  const secure = isSecureRequest(request, deps.config);
  const clear = clearIntentCookie(secure);
  const text = await readSmallBody(request);
  const fields = new URLSearchParams(text === "too large" ? "" : text);
  const tokenHash = fields.get("token_hash") ?? "";
  if (fields.get("type") !== "email" || !TOKEN_HASH.test(tokenHash)) return redirect(deps, "/sign-in?link=expired", [clear]);

  try {
    const verified = await deps.auth.verifyOtp(tokenHash, "email");
    if (!verified.ok) return redirect(deps, "/sign-in?link=expired", [clear]);
    const account = { userId: verified.userId, email: verified.email };

    // A browser holds one session: the one it had (any account) ends before the new one starts.
    const previous = await readAccount(request, deps);
    if (previous) await endAccountSession(deps.store, previous);

    await deps.accounts.ensureProfile(account.userId);
    const { token } = await createAccountSession(deps, account);

    let next = DEFAULT_RETURN;
    const intent = await takeSignInIntent(deps.store, cookieValue(request.headers.get("cookie"), SIGN_IN_COOKIE));
    if (intent && sameHash(intent.emailKey, emailKey(account.email, deps.config.sessionSecret))) {
      next = intent.next;
      const visitorToken = readVisitorToken(request);
      // The link is used up and the session exists: a failed attach must not lose the sign-in.
      if (visitorToken) {
        await attachVisitorAnalyses(deps, sha256Hex(visitorToken), account.userId).catch((e: unknown) => {
          console.error("Attaching analyses at sign-in failed:", e instanceof Error ? e.name : "unknown error");
        });
      }
    }
    return redirect(deps, next, [accountSetCookie(token, secure), clear]);
  } catch (e) {
    console.error("POST /auth/verify failed:", e instanceof AuthUnavailable ? `${e.name} (${e.code})` : e instanceof Error ? e.name : "unknown error");
    return redirect(deps, "/sign-in?link=unavailable", [clear]);
  }
}
