import { createClient, isAuthApiError, isAuthError, type SupabaseClient } from "@supabase/supabase-js";
import { isUuid } from "@/lib/accounts/data";
import { AuthRateLimited, AuthUnavailable, type AuthGateway, type VerifiedAccount } from "./gateway";

/**
 * The Supabase Auth gateway (production, and the gate stack in tests/db/auth.db.test.ts).
 * Server only: it holds the anon key and uses the service role client for the admin calls.
 *
 * Sign-in and verification run on a new anon client per call with no session
 * storage, so a verified session never outlives the call and never reaches
 * another request. verifyOtp keeps only the user id and email; the access and
 * refresh tokens in Supabase's answer are dropped there and never returned,
 * stored or logged. Failures log the operation and the provider's error code only.
 */

export interface SupabaseAuthOptions {
  readonly url: string;
  /** Server only. */
  readonly anonKey: string;
  /** The service role client (src/lib/supabase/client.ts) for getUser and deleteUser. */
  readonly admin: SupabaseClient;
  /** Per-request timeout. Default 10 s. */
  readonly timeoutMs?: number;
  /** Replaces fetch (tests answer with recorded provider responses). */
  readonly fetch?: typeof fetch;
}

type AuthErrorLike = { status?: number; code?: string; name?: string } | null;

function codeOf(error: AuthErrorLike, fallback: string): string {
  const code = error?.code;
  return typeof code === "string" && /^[a-z0-9_]{1,64}$/.test(code) ? code : fallback;
}

function unavailable(operation: string, error: unknown): AuthUnavailable {
  // A 5xx answer is an AuthRetryableFetchError with its status; a transport failure has status 0.
  const status = isAuthError(error) ? Number(error.status) : 0;
  const code = status > 0 ? codeOf(error as AuthErrorLike, `http_${status}`) : "request_failed";
  console.error(`[AUTH_UNAVAILABLE] auth ${operation} failed (${code})`);
  // 429 is a shared limit, 401 and 403 a wrong key: both stop every visitor. Any other 4xx refuses this request only.
  const refused = status >= 400 && status < 500 && ![401, 403, 429].includes(status);
  return new AuthUnavailable(operation, code, !refused);
}

/**
 * Supabase answers 429 `over_email_send_rate_limit` both for an address that asks again within its
 * frequency ("... only request this after 42 seconds.") and for the project-wide hourly email
 * limit ("Email rate limit exceeded"); only the first names a wait. The message is read for that
 * number only and never logged.
 */
function rateLimited(message: string): AuthRateLimited {
  const seconds = /\bafter (\d{1,5}) seconds?\b/i.exec(message)?.[1];
  return seconds === undefined ? new AuthRateLimited("project") : new AuthRateLimited("address", Number(seconds));
}


/**
 * True only for the provider's own "user not found" answer. A 404 of anything else (a wrong URL, a proxy,
 * another service) says nothing about the user, so it stays a failure.
 */
const userNotFound = (error: unknown): boolean => isAuthApiError(error) && error.status === 404 && error.code === "user_not_found";

export function createSupabaseAuthGateway(options: SupabaseAuthOptions): AuthGateway {
  const base = options.fetch ?? fetch;
  const ms = options.timeoutMs ?? 10_000;
  const timed: typeof fetch = (input, init) => base(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms) });
  const anon = () =>
    createClient(options.url, options.anonKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, flowType: "implicit" },
      global: { fetch: timed },
    }).auth;

  return {
    async signInWithOtp(email, redirectTo) {
      let error: unknown;
      try {
        ({ error } = await anon().signInWithOtp({ email, options: { emailRedirectTo: redirectTo, shouldCreateUser: true } }));
      } catch (e) {
        error = e;
      }
      if (!error) return;
      if (isAuthApiError(error) && error.status === 429) throw rateLimited(error.message);
      throw unavailable("signInWithOtp", error);
    },

    async verifyOtp(tokenHash, type) {
      let result: Awaited<ReturnType<ReturnType<typeof anon>["verifyOtp"]>>;
      try {
        result = await anon().verifyOtp({ token_hash: tokenHash, type });
      } catch (e) {
        throw unavailable("verifyOtp", e);
      }
      const { data, error } = result;
      // Supabase answers 4xx (otp_expired and others) for an expired, used or unknown link.
      if (isAuthApiError(error) && error.status >= 400 && error.status < 500 && error.status !== 429) return { ok: false, reason: "expired" };
      if (error) throw unavailable("verifyOtp", error);
      const user = data.user;
      if (!user?.id || !user.email) throw unavailable("verifyOtp", null);
      // data.session (the access and refresh tokens) is deliberately dropped here.
      return { ok: true, userId: user.id, email: user.email.toLowerCase() };
    },

    async getUser(userId): Promise<VerifiedAccount | null> {
      // Supabase Auth user ids are lower-case UUIDs (isUuid); anything else names no user.
      if (!isUuid(userId)) return null;
      let result: Awaited<ReturnType<SupabaseClient["auth"]["admin"]["getUserById"]>>;
      try {
        result = await options.admin.auth.admin.getUserById(userId);
      } catch (e) {
        throw unavailable("getUser", e);
      }
      const { data, error } = result;
      if (userNotFound(error)) return null;
      if (error) throw unavailable("getUser", error);
      const user = data?.user;
      // An answer without this user is not an answer about this user.
      if (user?.id !== userId || typeof user.email !== "string" || !user.email) throw unavailable("getUser", null);
      return { userId, email: user.email.toLowerCase() };
    },

    async deleteUser(userId) {
      if (!isUuid(userId)) throw new RangeError("userId must be a lower-case UUID");
      let error: unknown;
      try {
        ({ error } = await options.admin.auth.admin.deleteUser(userId));
      } catch (e) {
        error = e;
      }
      if (!error) return;
      // Already deleted (an earlier attempt whose answer was lost): the deletion is done.
      if (userNotFound(error)) return;
      throw unavailable("deleteUser", error);
    },
  };
}
