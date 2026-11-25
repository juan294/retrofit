import { createHmac } from "node:crypto";
import { normalizeEmail } from "@/lib/accounts/data";
import { safeReturnTo } from "@/lib/accounts/return-to";
import { isSameOrigin } from "@/lib/analysis/run";
import { isSecureRequest, readVisitorToken, VISITOR_MAX_AGE_S } from "@/lib/analysis/visitor";
import { AuthRateLimited, AuthUnavailable, type VerifiedAccount } from "@/lib/auth/gateway";
import type { Config } from "@/lib/config";
import { clientIdFromRequest } from "@/lib/fetch/limits";
import { buildCookie, hostCookieName } from "@/lib/security/cookies";
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
 * the link carries this cookie for the same address. For a link opened elsewhere (another
 * device, or a link someone else sent) the cookie then carries the pending sign-in
 * (startPending): the page names the verified address, and only Continue signs in.
 * This is the base name; signInCookieName gives the one in use.
 */
export const SIGN_IN_COOKIE = "retrofit_signin";
export const signInCookieName = (config: Pick<Config, "publicOrigin">) => hostCookieName(SIGN_IN_COOKIE, config);
export const SIGN_IN_TTL_S = 3600;
/** How long a verified address waits for Continue. */
export const PENDING_TTL_S = 600;
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

/** `Path=/`: the host-locked name needs it. */
const signInCookie = (token: string, config: Pick<Config, "publicOrigin">, secure: boolean, maxAge: number) => buildCookie(signInCookieName(config), token, { path: "/", maxAge, secure });

/** Clears the sign-in cookie (confirm does this on every answer but the address step). */
export const clearSignInCookie = (config: Pick<Config, "publicOrigin">, secure: boolean) => signInCookie("", config, secure, 0);

const knownKey = (key: string, visitorToken: string) => `signin-known:${key}:${sha256Hex(visitorToken)}`;

/** Remembers that this browser (its visitor cookie, hashed) signed in to the address: strangers then cannot use up its links. */
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
  return signInCookie(token, deps.config, secure, PENDING_TTL_S);
}

const readPending = async (store: Store, cookieToken: string | null | undefined): Promise<PendingSignIn | null> =>
  cookieToken && TOKEN_PATTERN.test(cookieToken) ? store.get<PendingSignIn>(pendingKey(sha256Hex(cookieToken))) : null;

/** The address that waits for this browser's Continue, or null. */
export async function pendingAddress(store: Store, cookieToken: string | null | undefined): Promise<string | null> {
  return (await readPending(store, cookieToken))?.email ?? null;
}

/** Reads and deletes this browser's pending sign-in, or null. */
export async function takePending(store: Store, cookieToken: string | null): Promise<VerifiedAccount | null> {
  const pending = await readPending(store, cookieToken);
  if (!pending || !cookieToken) return null;
  await store.delete(pendingKey(sha256Hex(cookieToken)));
  return { userId: pending.userId, email: pending.email };
}

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
 * against SIGNIN_PER_CLIENT_HOUR per network, SIGNIN_PER_EMAIL_NETWORK_HOUR per network and address, and
 * SIGNIN_PER_EMAIL_HOUR per address (the windows are keyed by emailKey). A browser that signed in to the
 * address before (rememberBrowser) has its own SIGNIN_PER_EMAIL_HOUR in place of the last two, so strangers
 * cannot lock it out. Then asks the provider for a link to PUBLIC_ORIGIN/auth/confirm. Errors: 400
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
    const client = clientIdFromRequest(request, deps.config, now);
    const visitorToken = readVisitorToken(request);
    const known = visitorToken !== null && (await isRememberedBrowser(deps, email, visitorToken));
    for (const [prefix, limit, id] of [
      ["signin-client", deps.config.signInPerClientHour, client],
      ...(known
        ? [["signin-own", deps.config.signInPerEmailHour, `${key}:${sha256Hex(visitorToken)}`] as const]
        : ([
            ["signin-pair", deps.config.signInPerEmailNetworkHour, `${key}:${client}`],
            ["signin-email", deps.config.signInPerEmailHour, key],
          ] as const)),
    ] as const) {
      const limited = await countIn(deps, prefix, limit, id, SIGN_IN_TEXT.limit);
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
    return json(200, { sent: true, message: SIGN_IN_TEXT.sent }, signInCookie(token, deps.config, isSecureRequest(request, deps.config), SIGN_IN_TTL_S));
  } catch (e) {
    // The error name only: a provider or database message can quote the address.
    console.error("POST /api/auth/sign-in failed:", e instanceof Error ? e.name : "unknown error");
    return json(503, { error: "unavailable", message: SIGN_IN_TEXT.unavailable });
  }
}
