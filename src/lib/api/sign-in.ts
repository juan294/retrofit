import { createHmac } from "node:crypto";
import { normalizeEmail } from "@/lib/accounts/data";
import { safeReturnTo } from "@/lib/accounts/return-to";
import { isSameOrigin } from "@/lib/analysis/run";
import { isSecureRequest, readVisitorToken, sameHash, VISITOR_MAX_AGE_S } from "@/lib/analysis/visitor";
import { AuthRateLimited, AuthUnavailable, type VerifiedAccount } from "@/lib/auth/gateway";
import type { Config } from "@/lib/config";
import { clientIdFromRequest } from "@/lib/fetch/limits";
import { buildCookie, hostCookieName } from "@/lib/security/cookies";
import { signInMailFailed } from "@/lib/ops/daily";
import { newToken, sha256Hex, TOKEN_PATTERN } from "@/lib/security/tokens";
import type { ServerDeps } from "@/lib/server/runtime";
import type { Store } from "@/lib/store/types";
import { SIGN_IN_TEXT } from "@/lib/site/sign-in-texts";
import { readSmallBody } from "./body";
import { json } from "./json";
import { countIn } from "./limits";

/**
 * The browser that asked for a link. Confirm signs in at once, attaches the visitor's
 * analyses and returns to the page sign-in started from only when the browser that opens
 * the link carries this cookie for the same address. A link opened elsewhere (another
 * device, or a link someone else sent) sets PENDING_COOKIE instead (startPending): the page
 * names the verified address, and only Continue signs in.
 * These are the base names; signInCookieName and pendingCookieName give the ones in use.
 */
export const SIGN_IN_COOKIE = "retrofit_signin";
export const signInCookieName = (config: Pick<Config, "publicOrigin">) => hostCookieName(SIGN_IN_COOKIE, config);
export const SIGN_IN_TTL_S = 3600;
export const PENDING_COOKIE = "retrofit_confirm";
export const pendingCookieName = (config: Pick<Config, "publicOrigin">) => hostCookieName(PENDING_COOKIE, config);
/** How long a verified address waits for Continue. */
export const PENDING_TTL_S = 600;
/** Links an hour that an address keeps for the browsers that signed in to it. */
export const SIGNIN_RESERVE_PER_HOUR = 1;
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

/** A keyed hash of the normalized address: the limits, the intent and the remembered browsers never hold the address. */
export function emailKey(email: string, secret: string): string {
  return createHmac("sha256", secret).update(`retrofit-signin-email-v1\n${email}`).digest("hex");
}

/** `Path=/`: the host-locked name needs it. */
const signInCookie = (token: string, config: Pick<Config, "publicOrigin">, secure: boolean, maxAge: number) => buildCookie(signInCookieName(config), token, { path: "/", maxAge, secure });

const pendingCookie = (token: string, config: Pick<Config, "publicOrigin">, secure: boolean, maxAge: number) => buildCookie(pendingCookieName(config), token, { path: "/", maxAge, secure });

export const clearSignInCookie = (config: Pick<Config, "publicOrigin">, secure: boolean) => signInCookie("", config, secure, 0);
export const clearPendingCookie = (config: Pick<Config, "publicOrigin">, secure: boolean) => pendingCookie("", config, secure, 0);

const knownKey = (key: string, visitorToken: string) => `signin-known:${key}:${sha256Hex(visitorToken)}`;

/** Remembers that this browser (its visitor cookie, hashed) signed in to the address: it keeps a link that strangers cannot use up. */
export async function rememberBrowser(deps: Pick<ServerDeps, "config" | "store">, email: string, visitorToken: string): Promise<void> {
  await deps.store.set(knownKey(emailKey(email, deps.config.sessionSecret), visitorToken), { version: 1 }, VISITOR_MAX_AGE_S);
}

export async function isRememberedBrowser(deps: Pick<ServerDeps, "config" | "store">, email: string, visitorToken: string | null): Promise<boolean> {
  return visitorToken !== null && (await deps.store.get(knownKey(emailKey(email, deps.config.sessionSecret), visitorToken))) !== null;
}

/** A verified sign-in that waits for Continue, in the Store under the SHA-256 of the browser's cookie. */
interface PendingSignIn {
  readonly version: number;
  readonly userId: string;
  readonly email: string;
}

const pendingKey = (hash: string) => `signin-pending:${hash}`;

/** Keeps a verified account for this browser's Continue. Returns the Set-Cookie value. */
export async function startPending(deps: Pick<ServerDeps, "config" | "store">, account: VerifiedAccount, secure: boolean): Promise<string> {
  const token = newToken();
  const pending: PendingSignIn = { version: 1, userId: account.userId, email: account.email };
  await deps.store.set(pendingKey(sha256Hex(token)), pending, PENDING_TTL_S);
  return pendingCookie(token, deps.config, secure, PENDING_TTL_S);
}

/** What waits for this browser's Continue, or null. `ref` binds the page's form to exactly this one (takePending). */
export async function pendingSignIn(store: Store, cookieToken: string | null | undefined): Promise<{ email: string; ref: string } | null> {
  if (!cookieToken || !TOKEN_PATTERN.test(cookieToken)) return null;
  const ref = sha256Hex(cookieToken);
  const pending = await store.get<PendingSignIn>(pendingKey(ref));
  return pending?.version === 1 ? { email: pending.email, ref } : null;
}

/**
 * Takes this browser's waiting sign-in, once (also among concurrent posts), or null. `ref`: the one whose
 * address the page showed; another link opened since then has replaced the cookie, and is not taken.
 */
export async function takePending(store: Store, cookieToken: string | null, ref: string): Promise<VerifiedAccount | null> {
  if (!cookieToken || !TOKEN_PATTERN.test(cookieToken) || !sameHash(sha256Hex(cookieToken), ref)) return null;
  const pending = await store.get<PendingSignIn>(pendingKey(ref));
  if (pending?.version !== 1 || !(await store.compareAndSet(pendingKey(ref), pending, { ...pending, version: 2 }, PENDING_TTL_S))) return null;
  await store.delete(pendingKey(ref));
  return { userId: pending.userId, email: pending.email };
}

/**
 * Reads and deletes the sign-in intent of the request's cookie when it is for `email`, or null. A link for
 * another address leaves it in place. Throws when the Store is unavailable.
 */
export async function takeSignInIntent(deps: Pick<ServerDeps, "config" | "store">, cookieToken: string | null, email: string): Promise<SignInIntent | null> {
  if (!cookieToken || !TOKEN_PATTERN.test(cookieToken)) return null;
  const key = intentKey(sha256Hex(cookieToken));
  const intent = await deps.store.get<SignInIntent>(key);
  if (!intent || !sameHash(intent.emailKey, emailKey(email, deps.config.sessionSecret))) return null;
  await deps.store.delete(key);
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
 * against SIGNIN_PER_CLIENT_HOUR per network, SIGNIN_PER_EMAIL_NETWORK_HOUR per network and address, and
 * SIGNIN_PER_EMAIL_HOUR per address (the windows are keyed by emailKey). Past the last two, a browser that
 * signed in to the address before (rememberBrowser) still gets SIGNIN_RESERVE_PER_HOUR, so strangers cannot
 * lock it out. Then asks the provider for a link to PUBLIC_ORIGIN/auth/confirm. Errors: 400
 * invalid_email, 413 too_large, 429 limit or wait `{error, message, retryAt}`, 429 mail_busy (the
 * provider's project-wide email limit; no retry time is known), 503 mail_unavailable
 * (the provider failed) or unavailable (the Store failed). Retrofit never logs or stores the address here; the
 * provider keeps an unconfirmed user until the daily cleanup (purgeUnconfirmedUsers). A used-up project limit and
 * repeated provider failures open an alert for the owner.
 */
export async function handleSignIn(request: Request, deps: Pick<ServerDeps, "config" | "store" | "auth" | "clock" | "waitUntil">): Promise<Response> {
  if (!isSameOrigin(request, deps.config)) return json(403, { error: "cross_origin", message: SIGN_IN_TEXT.crossOrigin });
  try {
    const text = await readSmallBody(request);
    if (text === "too large") return json(413, { error: "too_large", message: SIGN_IN_TEXT.tooLarge });
    const body = parse(text);
    if (!body?.email) return json(400, { error: "invalid_email", message: SIGN_IN_TEXT.invalidEmail });
    const { email } = body;

    const now = deps.clock();
    const key = emailKey(email, deps.config.sessionSecret);
    const client = clientIdFromRequest(request, deps.config, now);
    const count = (prefix: string, limit: number, id: string) => countIn(deps, prefix, limit, id, SIGN_IN_TEXT.limit);
    const network = await count("signin-client", deps.config.signInPerClientHour, client);
    if (network) return network;
    let limited = (await count("signin-pair", deps.config.signInPerEmailNetworkHour, `${key}:${client}`)) ?? (await count("signin-email", deps.config.signInPerEmailHour, key));
    if (limited && (await isRememberedBrowser(deps, email, readVisitorToken(request)))) limited = await count("signin-reserve", SIGNIN_RESERVE_PER_HOUR, key);
    if (limited) return limited;

    try {
      await deps.auth.signInWithOtp(email, `${deps.config.publicOrigin}/auth/confirm`);
    } catch (e) {
      if (e instanceof AuthRateLimited && e.scope === "project") {
        console.error("[AUTH_UNAVAILABLE] sign-in email limit of the project is used up");
        deps.waitUntil(signInMailFailed(deps, "limit"));
        return json(429, { error: "mail_busy", message: SIGN_IN_TEXT.mailBusy });
      }
      if (e instanceof AuthRateLimited) {
        const retryAt = new Date(now + (e.retryAfterSeconds ?? PROVIDER_WAIT_S) * 1000);
        return json(429, { error: "wait", message: SIGN_IN_TEXT.wait(retryAt), retryAt: retryAt.toISOString() });
      }
      if (e instanceof AuthUnavailable) {
        deps.waitUntil(signInMailFailed(deps, "provider"));
        return json(503, { error: "mail_unavailable", message: SIGN_IN_TEXT.mailUnavailable });
      }
      throw e;
    }

    const token = newToken();
    const intent: SignInIntent = { version: 1, emailKey: key, next: safeReturnTo(body.returnTo) };
    await deps.store.set(intentKey(sha256Hex(token)), intent, SIGN_IN_TTL_S);
    return json(200, { sent: true, message: SIGN_IN_TEXT.sent }, signInCookie(token, deps.config, isSecureRequest(request, deps.config), SIGN_IN_TTL_S));
  } catch (e) {
    // The error name only: a provider or database message can quote the address.
    console.error("POST /api/auth/sign-in failed:", e instanceof Error ? e.name : "unknown error");
    return json(503, { error: "unavailable", message: SIGN_IN_TEXT.unavailable });
  }
}
