import { DEFAULT_RETURN } from "@/lib/accounts/return-to";
import { accountSetCookie, cookieValue, createAccountSession } from "@/lib/accounts/session";
import { attachVisitorAnalyses } from "@/lib/analysis/owner";
import { isSecureRequest, readVisitorToken, sameHash } from "@/lib/analysis/visitor";
import { AuthUnavailable } from "@/lib/auth/gateway";
import { sha256Hex } from "@/lib/security/tokens";
import type { ServerDeps } from "@/lib/server/runtime";
import { SIGN_IN_COOKIE, clearIntentCookie, emailKey, takeSignInIntent } from "./sign-in";

/** Supabase email token hashes are hex; anything else is refused before the provider is asked. */
const TOKEN_HASH = /^[0-9a-f]{16,128}$/i;

function redirect(deps: Pick<ServerDeps, "config">, path: string, cookies: readonly string[]): Response {
  const headers = new Headers({ location: `${deps.config.publicOrigin}${path}`, "cache-control": "no-store", "referrer-policy": "no-referrer" });
  for (const c of cookies) headers.append("set-cookie", c);
  return new Response(null, { status: 303, headers });
}

/**
 * GET /auth/confirm?token_hash=<hash>&type=email: the link in the sign-in email (parent plan `confirm`).
 *
 * 1. Validates the query and verifies the token once with the provider (server side).
 * 2. Creates the account profile when absent and a Retrofit session (the `retrofit_account` cookie).
 * 3. When this browser asked for the link for the same address (the `retrofit_signin` cookie),
 *    attaches the visitor's analyses to the account and returns to the page sign-in started
 *    from; otherwise returns to /account and attaches nothing.
 *
 * Every answer is a 303 with no-store and no referrer, and clears `retrofit_signin`. An expired,
 * used, unknown or malformed link goes to /sign-in?link=expired; a provider or Store failure to
 * /sign-in?link=unavailable. The provider's own tokens never leave the gateway.
 */
export async function handleConfirm(request: Request, deps: Pick<ServerDeps, "config" | "store" | "accounts" | "auth" | "clock">): Promise<Response> {
  const secure = isSecureRequest(request, deps.config);
  const clear = clearIntentCookie(secure);
  const params = new URL(request.url).searchParams;
  const tokenHash = params.get("token_hash") ?? "";
  if (params.get("type") !== "email" || !TOKEN_HASH.test(tokenHash)) return redirect(deps, "/sign-in?link=expired", [clear]);

  try {
    const verified = await deps.auth.verifyOtp(tokenHash, "email");
    if (!verified.ok) return redirect(deps, "/sign-in?link=expired", [clear]);
    const account = { userId: verified.userId, email: verified.email };

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
    console.error("GET /auth/confirm failed:", e instanceof AuthUnavailable ? `${e.name} (${e.code})` : e instanceof Error ? e.name : "unknown error");
    return redirect(deps, "/sign-in?link=unavailable", [clear]);
  }
}
