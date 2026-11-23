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

export type SaveReportResult = { readonly outcome: "created" | "existing"; readonly report: SavedReportSummary } | { readonly outcome: "full" };

export interface AccountProfile {
  /** ISO 8601. */
  readonly createdAt: string;
}

/** How an owner proves control of a host (parent plan, "Ownership claims"). */
export type ClaimMethod = "meta" | "dns";
/** `superseded`: another account verified the host later; terminal (supabase/migrations/*_accounts.sql). */
export type ClaimStatus = "pending" | "verified" | "lapsed" | "superseded";

/** What the latest check found (src/lib/claims/verify.ts); null before the first check. */
export const CLAIM_RESULTS = [
  "verified",
  "tag_missing",
  "tag_mismatch",
  "robots_blocked",
  "robots_unavailable",
  "redirected",
  "http_status",
  "not_html",
  "timeout",
  "not_public",
  "fetch_failed",
  "record_missing",
  "record_mismatch",
  "dns_failed",
] as const;
export type ClaimResult = (typeof CLAIM_RESULTS)[number];

/** One ownership claim as server code reads it. Never sent to a browser as is: the page shows a view without the hash. */
export interface Claim {
  /** UUID. */
  readonly id: string;
  readonly accountId: string;
  /** The exact host (src/lib/claims/host.ts claimHost). */
  readonly host: string;
  readonly method: ClaimMethod;
  /** SHA-256 hex of the current token. The raw token is never stored. */
  readonly tokenHash: string;
  readonly status: ClaimStatus;
  /** ISO 8601. */
  readonly createdAt: string;
  /** ISO 8601: the latest move to verified, or null. */
  readonly verifiedAt: string | null;
  /** ISO 8601, or null before the first check. */
  readonly lastCheckedAt: string | null;
  /** Consecutive failed checks since the last pass. */
  readonly failures: number;
  /** ISO 8601: when another account took the host over, or null. */
  readonly supersededAt: string | null;
  readonly lastResult: ClaimResult | null;
  /** The HTTP status (http_status) or the number of tags or records found (tag_mismatch, record_mismatch). */
  readonly lastDetail: number | null;
}

export interface NewClaimInput {
  readonly host: string;
  readonly method: ClaimMethod;
  readonly tokenHash: string;
}

/** `exists`: the account already has a claim for the host (returned). `full`: MAX_PENDING_CLAIMS pending claims. */
export type CreateClaimResult = { readonly outcome: "created" | "exists"; readonly claim: Claim } | { readonly outcome: "full" };

/**
 * `restarted`: a new token (and method), back to pending. `verified` or `superseded`: refused, unchanged.
 * `full`: a lapsed claim would become the account's eleventh pending one. `missing`: not this account's claim.
 */
export type RestartClaimResult = { readonly outcome: "restarted"; readonly claim: Claim } | { readonly outcome: "verified" | "superseded"; readonly claim: Claim } | { readonly outcome: "full" | "missing" };

export interface ClaimCheckInput {
  /** The token hash the check compared with: a check against a token that Start over replaced is not applied. */
  readonly tokenHash: string;
  /** ISO 8601, from the server clock. */
  readonly checkedAt: string;
}

export interface ClaimFailureInput extends ClaimCheckInput {
  readonly result: Exclude<ClaimResult, "verified">;
  readonly detail: number | null;
}

/**
 * `updated` (or `verified` for verifyClaim): applied. `stale`: the token changed after the check started; nothing
 * applied. `superseded`: the claim is terminal; nothing applied. `missing`: no such claim.
 */
export type ClaimFailureResult = { readonly outcome: "updated" | "stale" | "superseded"; readonly claim: Claim } | { readonly outcome: "missing" };
export type VerifyClaimResult =
  | {
      readonly outcome: "verified";
      readonly claim: Claim;
      /** Accounts whose verified or lapsed claim for the host this verification superseded (Phase 4 pauses their published sites). */
      readonly movedFrom: readonly string[];
    }
  | { readonly outcome: "stale" | "superseded"; readonly claim: Claim }
  | { readonly outcome: "missing" };

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

  /**
   * Stores a copy of a report for the account, once per (host, fetchedAt): saving the same report
   * again answers `existing` with the first copy. An account keeps at most MAX_SAVED_REPORTS; past
   * that a new report answers `full` and nothing is stored. Atomic across instances. Throws
   * RangeError for invalid input before any write.
   */
  saveReport(accountId: string, input: SaveReportInput): Promise<SaveReportResult>;
  /** The account's saved reports, newest first, at most MAX_SAVED_REPORTS. Empty for an id that is not a UUID. */
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

  /**
   * Creates a pending claim for the account and host with the token hash. Atomic per account: the
   * account keeps at most MAX_PENDING_CLAIMS pending claims, and one claim per host (a second create
   * answers `exists` with the first). Throws RangeError for invalid input before any write.
   */
  createClaim(accountId: string, input: NewClaimInput): Promise<CreateClaimResult>;
  /** The account's claims, oldest first. Empty for an id that is not a UUID. */
  listClaims(accountId: string): Promise<Claim[]>;
  /** One claim of the account, or null for another account's, an unknown or a malformed id. */
  getClaim(accountId: string, claimId: string): Promise<Claim | null>;
  /**
   * Start over: replaces the token hash and method of a pending or lapsed claim and makes it pending,
   * with no check result. Atomic per account, under the same pending limit as createClaim.
   */
  restartClaim(accountId: string, claimId: string, input: Omit<NewClaimInput, "host">): Promise<RestartClaimResult>;
  /**
   * Records a failed check: one more consecutive failure, the result and the time. A verified or
   * lapsed claim with CLAIM_LAPSE_AFTER failures is lapsed; a pending claim stays pending.
   */
  recordClaimFailure(claimId: string, input: ClaimFailureInput): Promise<ClaimFailureResult>;
  /**
   * Records a passed check: the claim becomes verified with no failures. In the same transaction every
   * other account's verified or lapsed claim for the host becomes superseded (by this account, now), so
   * the host moves and the change is recorded. A superseded claim is never verified again.
   */
  verifyClaim(claimId: string, input: ClaimCheckInput): Promise<VerifyClaimResult>;
  /** Verified and lapsed claims last checked before `checkedBefore` (ISO 8601), least recently checked first, at most `limit`. */
  listClaimsDueForRecheck(checkedBefore: string, limit: number): Promise<Claim[]>;
  /** Withdraws one claim of the account (a published site of the claim goes with it). False when there was none. */
  deleteClaim(accountId: string, claimId: string): Promise<boolean>;
}

export { CLAIM_LAPSE_AFTER, MAX_PENDING_CLAIMS, MAX_SAVED_REPORTS } from "./limits";
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

const CLAIM_HOST = /^[a-z0-9.-]{1,253}(:[0-9]{1,5})?$/;

/** The claim rule of the contract above: a lower-case host (with an optional port), a known method and a SHA-256 hex hash. */
export function requireClaimInput(input: Partial<NewClaimInput>, needHost = true): void {
  if (needHost && (typeof input.host !== "string" || !CLAIM_HOST.test(input.host))) throw new RangeError("host must be a lower-case host name");
  if (input.method !== "meta" && input.method !== "dns") throw new RangeError("method must be meta or dns");
  if (typeof input.tokenHash !== "string" || !/^[0-9a-f]{64}$/.test(input.tokenHash)) throw new RangeError("tokenHash must be SHA-256 hex");
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
