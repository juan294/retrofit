import { ServiceUnavailable } from "@/lib/supabase/client";

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
   * carry the link (GET /unsubscribe?t=<token>, and /api/unsubscribe?t=<token> for one-click). Null on a repeat: the stored hash cannot be
   * turned back into a token. Never shown to the visitor, so a repeat signup
   * answers exactly like a new one.
   */
  readonly unsubscribeToken: string | null;
}

/** `unsubscribed`: recorded now. `already`: recorded earlier, unchanged. `unknown`: no signup has this hash. */
export type UnsubscribeResult = "unsubscribed" | "already" | "unknown";

/** A report as the account page lists it. */
export interface SavedReportSummary {
  /** UUID. */
  readonly id: string;
  readonly host: string;
  /** The report's score, or null for "No score". */
  readonly score: number | null;
  /** ISO 8601: when Retrofit read the site. */
  readonly fetchedAt: string;
  /** ISO 8601: when the account saved it. */
  readonly savedAt: string;
}

/** A saved report with its whole score/v1 body, for the read-only report view. */
export interface SavedReport extends SavedReportSummary {
  readonly report: Record<string, unknown>;
}

export interface SaveReportInput {
  /** The scored host, at most 253 characters. */
  readonly host: string;
  /** The score/v1 report body (an object, at most MAX_REPORT_BYTES as JSON). */
  readonly report: Record<string, unknown>;
  /** ISO 8601. */
  readonly fetchedAt: string;
}

export interface AccountProfile {
  /** ISO 8601. */
  readonly createdAt: string;
}

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

  /** Creates the account's profile row when absent; a repeat call changes nothing. Throws RangeError for an id that is not a UUID. */
  ensureProfile(accountId: string): Promise<void>;
  /** The profile, or null (also for an id that is not a UUID). */
  getProfile(accountId: string): Promise<AccountProfile | null>;

  /** Stores a copy of a report for the account. Throws RangeError for invalid input before any write. */
  saveReport(accountId: string, input: SaveReportInput): Promise<SavedReportSummary>;
  /** The account's saved reports, newest first, at most MAX_SAVED_REPORTS_LISTED. Empty for an id that is not a UUID. */
  listSavedReports(accountId: string): Promise<SavedReportSummary[]>;
  /** One saved report of the account, or null for another account's, an unknown or a malformed id. */
  getSavedReport(accountId: string, reportId: string): Promise<SavedReport | null>;

  /**
   * Deletes every row the account owns (claims, published sites, saved reports, API keys, billing
   * and the profile) in one atomic step: on failure nothing is deleted. Idempotent. Throws
   * RangeError for an id that is not a UUID. Account deletion (src/lib/accounts/delete.ts) calls
   * it before it deletes the Supabase Auth user.
   */
  deleteAccountData(accountId: string): Promise<void>;
}

export const MAX_SAVED_REPORTS_LISTED = 100;
/** A score/v1 report is a few kilobytes; this bound only refuses something that is not one. */
export const MAX_REPORT_BYTES = 256 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** True for a lower-case UUID (an account or saved report id). */
export function isUuid(id: string): boolean {
  return UUID.test(id);
}

export function requireAccountId(accountId: string): string {
  if (!isUuid(accountId)) throw new RangeError("accountId must be a UUID");
  return accountId;
}

/** The save rule of the contract above. Returns the normalized fetch time (ISO 8601). */
export function requireSaveInput(input: SaveReportInput): string {
  const { host, report, fetchedAt } = input;
  if (typeof host !== "string" || host.length === 0 || host.length > 253) throw new RangeError("host must be 1 to 253 characters");
  if (typeof report !== "object" || report === null || Array.isArray(report)) throw new RangeError("report must be an object");
  if (Buffer.byteLength(JSON.stringify(report)) > MAX_REPORT_BYTES) throw new RangeError("report is too large");
  const ms = typeof fetchedAt === "string" ? Date.parse(fetchedAt) : NaN;
  if (!Number.isFinite(ms)) throw new RangeError("fetchedAt must be an ISO date and time");
  return new Date(ms).toISOString();
}

/** The score field of a stored report: a finite number, else null. */
export function scoreOf(report: unknown): number | null {
  const score = (report as { score?: unknown } | null)?.score;
  return typeof score === "number" && Number.isFinite(score) ? score : null;
}

/** A failed AccountData call in an adapter that depends on a service. Callers fail closed. */
export class AccountDataUnavailable extends ServiceUnavailable {
  constructor(operation: string, code: string) {
    super(operation, code, `account data ${operation} failed (${code})`);
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
