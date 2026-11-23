import { createHmac } from "node:crypto";
import { normalizeEmail } from "@/lib/accounts/data";
import { safeReturnTo } from "@/lib/accounts/return-to";
import { isSameOrigin } from "@/lib/analysis/run";
import { isSecureRequest } from "@/lib/analysis/visitor";
import { AuthRateLimited, AuthUnavailable } from "@/lib/auth/gateway";
import { clientIdFromRequest, countClientWindow } from "@/lib/fetch/limits";
import { buildCookie } from "@/lib/security/cookies";
import { newToken, sha256Hex, TOKEN_PATTERN } from "@/lib/security/tokens";
import type { ServerDeps } from "@/lib/server/runtime";
import type { Store } from "@/lib/store/types";
import { SIGN_IN_TEXT } from "@/lib/site/sign-in-texts";
import { readSmallBody } from "./body";
import { json, limitOr429 } from "./json";

/**
 * The browser that asked for a link. Confirm attaches the visitor's analyses and
 * returns to the page sign-in started from only when the browser that opens the
 * link carries this cookie for the same address; a link opened elsewhere (another
 * device, or a link someone else sent) signs in to /account and attaches nothing.
 */
export const SIGN_IN_COOKIE = "retrofit_signin";
export const SIGN_IN_TTL_S = 3600;
/** How long the page waits when Supabase refuses to send another link so soon and names no wait. */
export const PROVIDER_WAIT_S = 60;

export interface SignInIntent {
  readonly version: number;
  /** emailKey(address): which address the link must verify. */
  readonly emailKey: string;
  /** The same-origin path sign-in returns to (safeReturnTo). */
  readonly next: string;
}

const intentKey = (hash: string) => `signin:${hash}`;

/** A keyed hash of the normalized address: the Store never holds the address for sign-in. */
export function emailKey(email: string, secret: string): string {
  return createHmac("sha256", secret).update(`retrofit-signin-email-v1\n${email}`).digest("hex");
}

const intentCookie = (token: string, secure: boolean, maxAge = SIGN_IN_TTL_S) => buildCookie(SIGN_IN_COOKIE, token, { path: "/auth", maxAge, secure });

/** Clears the sign-in cookie (confirm does this on every answer). */
export const clearIntentCookie = (secure: boolean) => intentCookie("", secure, 0);

/** Reads and deletes the sign-in intent of the request's cookie, or null. Throws when the Store is unavailable. */
export async function takeSignInIntent(store: Store, cookieToken: string | null): Promise<SignInIntent | null> {
  if (!cookieToken || !TOKEN_PATTERN.test(cookieToken)) return null;
  const key = intentKey(sha256Hex(cookieToken));
  const intent = await store.get<SignInIntent>(key);
  if (intent) await store.delete(key);
  return intent;
}

function parse(text: string): { email: string | null; returnTo: unknown } | null {
  try {
    const body = JSON.parse(text) as { email?: unknown; returnTo?: unknown } | null;
    if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
    return { email: typeof body.email === "string" ? normalizeEmail(body.email) : null, returnTo: body.returnTo };
  } catch {
    return null;
  }
}

/**
 * POST /api/auth/sign-in `{email, returnTo?}` -> 200 `{sent: true, message}` for every valid
 * address, known or not (parent plan `signIn`). Same-origin only (403). Counts every valid request
 * against SIGNIN_PER_CLIENT_HOUR per network and SIGNIN_PER_EMAIL_HOUR per address (the window is
 * keyed by emailKey), then asks the provider for a link to PUBLIC_ORIGIN/auth/confirm. Errors: 400
 * invalid_email, 413 too_large, 429 limit or wait `{error, message, retryAt}`, 429 mail_busy (the
 * provider's project-wide email limit; no retry time is known), 503 mail_unavailable
 * (the provider failed) or unavailable (the Store failed). The address is never logged or stored.
 */
export async function handleSignIn(request: Request, deps: Pick<ServerDeps, "config" | "store" | "auth" | "clock">): Promise<Response> {
  if (!isSameOrigin(request, deps.config)) return json(403, { error: "cross_origin", message: SIGN_IN_TEXT.crossOrigin });
  try {
    const text = await readSmallBody(request);
    if (text === "too large") return json(413, { error: "too_large", message: SIGN_IN_TEXT.tooLarge });
    const body = parse(text);
    if (!body?.email) return json(400, { error: "invalid_email", message: SIGN_IN_TEXT.invalidEmail });
    const { email } = body;

    const now = deps.clock();
    const key = emailKey(email, deps.config.sessionSecret);
    for (const [prefix, limit, id] of [
      ["signin-client", deps.config.signInPerClientHour, clientIdFromRequest(request, deps.config, now)],
      ["signin-email", deps.config.signInPerEmailHour, key],
    ] as const) {
      const limited = limitOr429(await countClientWindow(deps.store, prefix, limit, id, now), SIGN_IN_TEXT.limit);
      if (limited) return limited;
    }

    try {
      await deps.auth.signInWithOtp(email, `${deps.config.publicOrigin}/auth/confirm`);
    } catch (e) {
      if (e instanceof AuthRateLimited && e.scope === "project") return json(429, { error: "mail_busy", message: SIGN_IN_TEXT.mailBusy });
      if (e instanceof AuthRateLimited) {
        const retryAt = new Date(now + (e.retryAfterSeconds ?? PROVIDER_WAIT_S) * 1000);
        return json(429, { error: "wait", message: SIGN_IN_TEXT.wait(retryAt), retryAt: retryAt.toISOString() });
      }
      if (e instanceof AuthUnavailable) return json(503, { error: "mail_unavailable", message: SIGN_IN_TEXT.mailUnavailable });
      throw e;
    }

    const token = newToken();
    const intent: SignInIntent = { version: 1, emailKey: key, next: safeReturnTo(body.returnTo) };
    await deps.store.set(intentKey(sha256Hex(token)), intent, SIGN_IN_TTL_S);
    return json(200, { sent: true, message: SIGN_IN_TEXT.sent }, intentCookie(token, isSecureRequest(request, deps.config)));
  } catch (e) {
    // The error name only: a provider or database message can quote the address.
    console.error("POST /api/auth/sign-in failed:", e instanceof Error ? e.name : "unknown error");
    return json(503, { error: "unavailable", message: SIGN_IN_TEXT.unavailable });
  }
}
