/**
 * AuthGateway: the only boundary between Retrofit and its email-link sign-in
 * provider (Supabase Auth in production, src/lib/auth/supabase.ts). Server only.
 *
 * Supabase verifies the email address; Retrofit then issues its own session
 * (src/lib/accounts/session.ts). A gateway never returns, stores or logs the
 * provider's access or refresh tokens: verifyOtp answers only the account id
 * and the email address.
 */

/** The verified account. `userId` is the Supabase Auth user id (a UUID). */
export interface VerifiedAccount {
  readonly userId: string;
  /** Lower case. */
  readonly email: string;
}

/** `expired`: the link is expired, already used or unknown. The provider does not tell these apart. */
export type VerifyResult = ({ readonly ok: true } & VerifiedAccount) | { readonly ok: false; readonly reason: "expired" };

export interface AuthGateway {
  /**
   * Asks the provider to email a sign-in link to `email` (creating the account when it is new).
   * `redirectTo` is the page the link opens. Throws AuthRateLimited when the provider refuses
   * to send again so soon, and AuthUnavailable for every other failure.
   */
  signInWithOtp(email: string, redirectTo: string): Promise<void>;
  /** Verifies the link's token hash once. Throws AuthUnavailable when the provider cannot answer. */
  verifyOtp(tokenHash: string, type: "email"): Promise<VerifyResult>;
  /** The account, or null when it does not exist. Throws AuthUnavailable. Account deletion calls it first, so a provider outage deletes nothing. */
  getUser(userId: string): Promise<VerifiedAccount | null>;
  /** Deletes the provider's user. An account that no longer exists counts as deleted. Throws AuthUnavailable. */
  deleteUser(userId: string): Promise<void>;
}

/** The provider failed or could not be reached. Callers fail closed. `code` is the provider's error code, never a message. */
export class AuthUnavailable extends Error {
  constructor(
    public readonly operation: string,
    public readonly code: string,
  ) {
    super(`auth ${operation} failed (${code})`);
    this.name = "AuthUnavailable";
  }
}

/** The provider refused to send another email this soon. */
export class AuthRateLimited extends Error {
  constructor() {
    super("auth signInWithOtp rate limited");
    this.name = "AuthRateLimited";
  }
}

/** A gateway that answers AuthUnavailable to every call: local development without Supabase Auth. */
export function unavailableAuthGateway(): AuthGateway {
  const fail = (operation: string) => async (): Promise<never> => {
    throw new AuthUnavailable(operation, "not_configured");
  };
  return { signInWithOtp: fail("signInWithOtp"), verifyOtp: fail("verifyOtp"), getUser: fail("getUser"), deleteUser: fail("deleteUser") };
}
