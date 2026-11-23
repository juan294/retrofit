import { randomBytes, randomUUID } from "node:crypto";
import { AuthRateLimited, AuthUnavailable, type AuthGateway, type VerifiedAccount, type VerifyResult } from "@/lib/auth/gateway";
import type { Clock } from "@/lib/store/types";

/**
 * Fixtures mode only: an in-memory stand-in for Supabase Auth with the same
 * observable rules (one-time links that expire after an hour, one account per
 * address, a missing user counts as deleted). It writes each sign-in email to a
 * mailbox that browser tests read through /test-fixtures/mailbox, because the
 * gate tears the Supabase stack down before Playwright runs. Unit tests use it
 * as the fake provider and make operations fail on purpose. Production never
 * builds it (src/lib/server/runtime.ts uses it only when RETROFIT_TEST_FIXTURES
 * is set, which loadConfig refuses on Vercel).
 */

export const FIXTURE_LINK_TTL_MS = 3600 * 1000;

export interface SentLink {
  readonly email: string;
  /** The link the email carries: `<origin>/auth/confirm?token_hash=<hash>&type=email`. */
  readonly link: string;
  readonly redirectTo: string;
  readonly at: number;
}

export type FixtureFailure = "unavailable" | "rate_limited";

export interface FixtureAuth extends AuthGateway {
  /** Every email sent, oldest first. */
  readonly sent: readonly SentLink[];
  /** The newest link sent to `email` (any case), or null. */
  latestLink(email: string): string | null;
  /** Makes every later call of `operation` fail until heal(). */
  fail(operation: keyof AuthGateway, how?: FixtureFailure): void;
  heal(): void;
  /** Every call, in order (operation names only). */
  readonly calls: readonly string[];
  /** The account id of `email`, or null when it has none. */
  userIdOf(email: string): string | null;
}

interface Token {
  readonly email: string;
  readonly expiresAt: number;
  used: boolean;
}

export function createFixtureAuth(options: { clock: Clock; origin: string }): FixtureAuth {
  const users = new Map<string, string>();
  const tokens = new Map<string, Token>();
  const sent: SentLink[] = [];
  const failures = new Map<keyof AuthGateway, FixtureFailure>();
  const calls: string[] = [];

  function enter(operation: keyof AuthGateway): void {
    calls.push(operation);
    const how = failures.get(operation);
    if (how === "rate_limited") throw new AuthRateLimited();
    if (how) throw new AuthUnavailable(operation, "fixture_failure");
  }

  const emailOf = (userId: string) => [...users].find(([, id]) => id === userId)?.[0];

  return {
    sent,
    calls,
    async signInWithOtp(email, redirectTo) {
      enter("signInWithOtp");
      const address = email.toLowerCase();
      if (!users.has(address)) users.set(address, randomUUID());
      const hash = randomBytes(28).toString("hex");
      tokens.set(hash, { email: address, expiresAt: options.clock() + FIXTURE_LINK_TTL_MS, used: false });
      sent.push({ email: address, link: `${options.origin}/auth/confirm?token_hash=${hash}&type=email`, redirectTo, at: options.clock() });
    },
    async verifyOtp(tokenHash, type): Promise<VerifyResult> {
      enter("verifyOtp");
      const token = tokens.get(tokenHash);
      if (type !== "email" || !token || token.used || options.clock() >= token.expiresAt) return { ok: false, reason: "expired" };
      token.used = true;
      const userId = users.get(token.email);
      if (!userId) return { ok: false, reason: "expired" };
      return { ok: true, userId, email: token.email };
    },
    async getUser(userId): Promise<VerifiedAccount | null> {
      enter("getUser");
      const email = emailOf(userId);
      return email ? { userId, email } : null;
    },
    async deleteUser(userId) {
      enter("deleteUser");
      const email = emailOf(userId);
      if (email) users.delete(email);
    },
    latestLink(email) {
      const address = email.toLowerCase();
      return sent.findLast((s) => s.email === address)?.link ?? null;
    },
    fail(operation, how = "unavailable") {
      failures.set(operation, how);
    },
    heal() {
      failures.clear();
    },
    userIdOf(email) {
      return users.get(email.toLowerCase()) ?? null;
    },
  };
}

// One fixture provider per process (shared by the routes and /test-fixtures/mailbox), kept on
// globalThis so development reloads share it.
const g = globalThis as typeof globalThis & { __retrofitFixtureAuth?: FixtureAuth };

/** The process-wide fixture provider. Callers check fixtures mode first (runtime.ts, the mailbox route). */
export function processFixtureAuth(options: { clock: Clock; origin: string }): FixtureAuth {
  g.__retrofitFixtureAuth ??= createFixtureAuth(options);
  return g.__retrofitFixtureAuth;
}
