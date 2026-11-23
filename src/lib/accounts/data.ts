import { createHash, randomBytes } from "node:crypto";

/**
 * AccountData: Retrofit's relational account data (supabase/migrations/*_accounts.sql),
 * shared by the memory adapter (tests, local development) and the Supabase adapter
 * (production). Later phases add their methods here with contract tests in
 * tests/accounts/data-contract.ts. Server only.
 *
 * Privacy rules every adapter keeps: an email address or a raw token is never
 * logged; a raw token is never stored (only its SHA-256).
 */

/** One "notify me" signup as the server reads it. The unsubscribe token hash is never returned. */
export interface NotifySignup {
  /** Trimmed, lower case. */
  readonly email: string;
  readonly marketingConsent: boolean;
  /** ISO 8601. */
  readonly createdAt: string;
  /** ISO 8601, or null while subscribed. */
  readonly unsubscribedAt: string | null;
}

export interface NotifySignupResult {
  /** True only when this call stored a new signup. */
  readonly created: boolean;
  /**
   * The raw unsubscribe token, only on a new signup, so the first message can
   * carry the link (unsubscribeUrl). Null on a repeat: the stored hash cannot be
   * turned back into a token. Never shown to the visitor, so a repeat signup
   * answers exactly like a new one.
   */
  readonly unsubscribeToken: string | null;
}

/** `unsubscribed`: recorded now. `already`: recorded earlier, unchanged. `unknown`: no signup has this hash. */
export type UnsubscribeResult = "unsubscribed" | "already" | "unknown";

export interface AccountData {
  /**
   * Stores a signup for `email` (trimmed, lower case) with `consent` (default
   * false) and a new unsubscribe token hash. A repeat signup for a stored
   * address changes nothing, including consent and an earlier unsubscribe.
   * Throws RangeError for an invalid address before any write.
   */
  addNotifySignup(email: string, consent?: boolean): Promise<NotifySignupResult>;
  /** The signup for `email` (any case), or null. Null for an invalid address. */
  findNotifySignup(email: string): Promise<NotifySignup | null>;
  /** Records the unsubscribe time once for the signup whose token hash is `tokenHash` (SHA-256 hex). */
  unsubscribe(tokenHash: string): Promise<UnsubscribeResult>;
}

/** A failed AccountData call in an adapter that depends on a service. Callers fail closed. */
export class AccountDataUnavailable extends Error {
  constructor(
    public readonly operation: string,
    /** PostgREST or Postgres error code, or "request_failed" for a transport failure. */
    public readonly code: string,
  ) {
    super(`account data ${operation} failed (${code})`);
    this.name = "AccountDataUnavailable";
  }
}

const MAX_EMAIL = 254;
const MAX_LOCAL = 64;
// Dot-atom local part (RFC 5322 atext) and an ASCII host name with a dot. Quoted local parts and
// address literals are refused; they are valid but rare, and a refusal only asks for another address.
const LOCAL = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const DOMAIN = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** Trims and lower-cases `raw`; null when it is not a plausible email address. */
export function normalizeEmail(raw: string): string | null {
  const email = raw.trim().toLowerCase();
  if (email.length > MAX_EMAIL) return null;
  const at = email.lastIndexOf("@");
  if (at <= 0) return null;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (local.length > MAX_LOCAL || !LOCAL.test(local) || !DOMAIN.test(domain)) return null;
  return email;
}

/** The address rule of the contract above: an invalid address is refused before any write. */
export function requireEmail(raw: string): string {
  const email = normalizeEmail(raw);
  if (email === null) throw new RangeError("email must be a valid email address");
  return email;
}

/** 128 random bits in lower-case hex: the unsubscribe token (and later one-time tokens). */
export const TOKEN_PATTERN = /^[0-9a-f]{32}$/;
export const TOKEN_HASH_PATTERN = /^[0-9a-f]{64}$/;

export function newToken(): string {
  return randomBytes(16).toString("hex");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** The unsubscribe link every message to a signup carries: GET /unsubscribe?t=<token>. */
export function unsubscribeUrl(origin: string, token: string): string {
  if (!TOKEN_PATTERN.test(token)) throw new RangeError("token must be 32 lower-case hex characters");
  return `${origin}/unsubscribe?t=${token}`;
}
