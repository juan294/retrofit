import { createClient, isAuthApiError, isAuthError, type SupabaseClient } from "@supabase/supabase-js";
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
  return new AuthUnavailable(operation, code);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
      if (isAuthApiError(error) && error.status === 429) throw new AuthRateLimited();
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
      if (!UUID.test(userId)) return null;
      let result: Awaited<ReturnType<SupabaseClient["auth"]["admin"]["getUserById"]>>;
      try {
        result = await options.admin.auth.admin.getUserById(userId);
      } catch (e) {
        throw unavailable("getUser", e);
      }
      const { data, error } = result;
      if (isAuthApiError(error) && error.status === 404) return null;
      if (error) throw unavailable("getUser", error);
      return data.user?.email ? { userId: data.user.id, email: data.user.email.toLowerCase() } : null;
    },

    async deleteUser(userId) {
      if (!UUID.test(userId)) throw new RangeError("userId must be a UUID");
      let error: unknown;
      try {
        ({ error } = await options.admin.auth.admin.deleteUser(userId));
      } catch (e) {
        error = e;
      }
      if (!error) return;
      // Already deleted (an earlier attempt whose answer was lost): the deletion is done.
      if (isAuthApiError(error) && error.status === 404) return;
      throw unavailable("deleteUser", error);
    },
  };
}
