import type { BillingState } from "@/lib/billing/state";
import { PLANS } from "@/lib/billing/plans";
import { isNormalizedHost } from "@/lib/fetch/url";
import type { AgentSnapshot } from "@/lib/snapshot/types";
import { SHA256_HEX_PATTERN } from "@/lib/security/tokens";
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
  "crawl_delay",
  "dns_timeout",
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
  /** ISO 8601: when the claim lapsed (kept by later failures), or null while it is not lapsed. */
  readonly lapsedAt: string | null;
  readonly lastResult: ClaimResult | null;
  /** The HTTP status (http_status), the number of tags or records found (tag_mismatch, record_mismatch), or the Crawl-delay in seconds (crawl_delay). */
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
      /** Accounts whose verified or lapsed claim for the host this verification superseded. */
      readonly movedFrom: readonly string[];
    }
  | { readonly outcome: "stale" | "superseded"; readonly claim: Claim }
  | { readonly outcome: "missing" };

/**
 * Why a refresh of a published site failed: a code, never page text (the page's copy names it). A refresh
 * without a newer read is not a failed refresh, so it has no code here.
 */
export const REFRESH_ERRORS = ["no_analysis", "generation_failed", "too_large"] as const;
export type RefreshError = (typeof REFRESH_ERRORS)[number];

export interface PublishSiteInput {
  /** The claimed host, normalized (isNormalizedHost). */
  readonly host: string;
  /** The stored form (agentSnapshot), at most MAX_PUBLISHED_SNAPSHOT_BYTES as JSON. Untrusted site data. */
  readonly snapshot: AgentSnapshot;
  /** The score/v1 report body, at most MAX_REPORT_BYTES as JSON. */
  readonly report: Record<string, unknown>;
  /** ISO 8601: when Retrofit read the site. A refresh must be newer. */
  readonly fetchedAt: string;
  /** ISO 8601, from the server clock. */
  readonly now: string;
}

/** A published site as its owner's account page reads it (also while it is paused). */
export interface PublishedSite {
  readonly host: string;
  readonly claimId: string;
  readonly score: number | null;
  /** ISO 8601: when Retrofit read the site. */
  readonly fetchedAt: string;
  /** ISO 8601: the first publish by this account. */
  readonly publishedAt: string;
  /** ISO 8601: the latest publish or refresh. */
  readonly refreshedAt: string;
  /** The latest refresh failed with this code; cleared by the next success. */
  readonly lastRefreshError: RefreshError | null;
}

/** A published site as any visitor may see it (getPublicSite: without the report and the snapshot). */
export type PublicSite = Omit<PublishedSite, "claimId" | "lastRefreshError">;
export type PublicReport = PublicSite & { readonly report: Record<string, unknown> };
export type PublicSnapshot = PublicSite & { readonly snapshot: AgentSnapshot };

/**
 * `published`: the account's first publication of the host (or the first after a transfer). `refreshed`: a newer
 * analysis replaced its snapshot. `no_claim`, `not_verified`: the account holds no claim, or no verified one, for the
 * host. `not_newer`: the published snapshot is as new or newer; nothing changed (`site`: as it is).
 */
export type PublishSiteResult = { readonly outcome: "published" | "refreshed" | "not_newer"; readonly site: PublishedSite } | { readonly outcome: "no_claim" | "not_verified" };

/** The account's Stripe link and the subscription state last read from Stripe (src/lib/billing/state.ts). Server only. */
export interface BillingRecord extends BillingState {
  readonly accountId: string;
  readonly customerId: string;
  /** ISO 8601: when the stored state was read from Stripe; null before the first read. */
  readonly stateAt: string | null;
}

/** A state read from Stripe at `observedAt` (ISO 8601, when the read started): an older read never replaces a newer one. */
export interface ObservedBilling extends BillingState {
  readonly observedAt: string;
}

export interface BillingEventId {
  /** The Stripe event id (evt_...). */
  readonly id: string;
  readonly type: string;
}

/** `linked`: stored now. `existing`: the account already has a customer (returned). `taken`: the customer is another account's. `no_account`: no such account. */
export type LinkCustomerResult = { readonly outcome: "linked" | "existing"; readonly billing: BillingRecord } | { readonly outcome: "taken" | "no_account" };
/** `stale`: a newer read is stored; nothing changed (and no event recorded). `unknown`: no account has this customer; nothing stored. */
export type ApplyBillingResult = { readonly outcome: "applied" | "stale"; readonly billing: BillingRecord } | { readonly outcome: "unknown" };
/** `duplicate`: the event was recorded before; nothing changed. */
export type ApplyEventResult = ApplyBillingResult | { readonly outcome: "duplicate" };

/** An active API key as its owner's account page lists it. The key and its hash are never returned. */
export interface ApiKey {
  /** UUID. */
  readonly id: string;
  /** The key's last four characters, or null. */
  readonly hint: string | null;
  /** ISO 8601. */
  readonly createdAt: string;
}

export interface NewApiKey {
  /** SHA-256 hex of the key. */
  readonly keyHash: string;
  /** The key's last four characters. */
  readonly hint: string;
}

export type CreateApiKeyResult = { readonly outcome: "created"; readonly key: ApiKey } | { readonly outcome: "full" };

export interface AccountData {
  /**
   * Resolves when the newest objects that the account features need exist and can be read (it reads no row), so a
   * deployment before its migrations is found. Throws AccountDataUnavailable.
   */
  checkReady(): Promise<void>;
  /**
   * Deletes sign-in users that were never confirmed, have no account profile, and whose last email was sent before
   * `before` (ISO 8601), at most `limit`. Returns how many. A confirmed user, or one with a profile, is never deleted.
   */
  purgeUnconfirmedUsers(before: string, limit: number): Promise<number>;

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
  /** The host of one saved report of the account (without reading the report), or null as getSavedReport. */
  getSavedReportHost(accountId: string, reportId: string): Promise<string | null>;

  /**
   * Deletes every row the account owns (claims, published sites, saved reports, API keys, billing
   * and the profile) and marks its Stripe customer as deleted (isDeletedCustomer) in one atomic step: on
   * failure nothing is deleted. Idempotent. Throws
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
   * the host moves and the change is recorded; every other account's publication of the host is deleted
   * (also one paused by a pending claim), so it can never become public again. A superseded claim is never
   * verified again.
   */
  verifyClaim(claimId: string, input: ClaimCheckInput): Promise<VerifyClaimResult>;
  /**
   * The claims due for the daily recheck at `now` (ISO 8601), at most `limit`: verified and lapsed claims last checked over
   * CLAIM_RECHECK_AFTER_S before `now`; a claim lapsed over CLAIM_SLOW_AFTER_S before `now` only once its last check is over
   * CLAIM_SLOW_RECHECK_AFTER_S old. Verified claims first, then lapsed ones, each least recently checked or attempted first.
   */
  listClaimsDueForRecheck(now: string, limit: number): Promise<Claim[]>;
  /** Records that a recheck was attempted at `at` (ISO 8601) without a result, so the claim goes behind the others that are due. An unknown claim is no error. */
  recordClaimAttempt(claimId: string, at: string): Promise<void>;
  /** Withdraws one claim of the account (a published site of the claim goes with it). False when there was none. */
  deleteClaim(accountId: string, claimId: string): Promise<boolean>;

  /**
   * Publishes the account's site for the host, or refreshes it, in one transaction that checks again that
   * the account's claim for the host is verified (it may have lapsed or moved since the caller looked) and
   * that a refresh is newer. A publication of another account for the host is replaced. Throws RangeError
   * for invalid or oversized input before any write.
   */
  publishSite(accountId: string, input: PublishSiteInput): Promise<PublishSiteResult>;
  /** Records why a refresh failed on the account's own publication (returned as it is then); the published snapshot stays. Null when there is none. */
  recordRefreshError(accountId: string, host: string, code: RefreshError): Promise<PublishedSite | null>;
  /** Removes the account's publication of the host. False when there is none. The claim stays. */
  unpublishSite(accountId: string, host: string): Promise<boolean>;
  /** The account's publications, also paused ones, by host. Empty for an id that is not a UUID. */
  listPublishedSites(accountId: string): Promise<PublishedSite[]>;
  /**
   * The host's public site, or null. The ONE rule, shared by the next four reads: a site is public only while its
   * publication exists and its claim is verified, for that host, and held by the publication's account. A lapse,
   * Start over, a transfer, removing the claim, unpublishing and account deletion all end it at once. One round
   * trip. Null for a host that is not normalized. This light read loads neither the snapshot nor the report.
   */
  getPublicSite(host: string): Promise<PublicSite | null>;
  /** The public site with its report (the page). */
  getPublicReport(host: string): Promise<PublicReport | null>;
  /** The public site with its snapshot (the agent files). */
  getPublicSnapshot(host: string): Promise<PublicSnapshot | null>;
  /** Hosts with a public site, the most recently refreshed first, at most `limit` (the sitemap). */
  listPublicHosts(limit: number): Promise<string[]>;

  /** The account's billing record, or null before its first checkout (also for an id that is not a UUID). */
  getBilling(accountId: string): Promise<BillingRecord | null>;
  /** The billing record of a Stripe customer, or null. */
  getBillingByCustomer(customerId: string): Promise<BillingRecord | null>;
  /**
   * Binds a Stripe customer to the account, once: one customer per account and one account per customer,
   * atomic across instances. `no_account` without a profile (its data was deleted, or it never signed in), also
   * against a deletion in progress. Linking removes the customer's deletion mark. Throws RangeError for an invalid
   * id before any write.
   */
  linkBillingCustomer(accountId: string, customerId: string): Promise<LinkCustomerResult>;
  /** Stores the state read from Stripe for a linked customer, unless a newer read is stored. Throws RangeError for invalid input. */
  applyBillingState(customerId: string, state: ObservedBilling): Promise<ApplyBillingResult>;
  /**
   * applyBillingState for one webhook event, in one transaction with the event's record: an event is applied at most
   * once, and a failure records nothing, so its redelivery applies. A stale event, and one of an unknown customer, is
   * not recorded, so that reading Stripe again, or the redelivery, can apply it. applyBillingState and this one keep
   * the first `unpaidSince` while the same subscription stays past due.
   */
  applyBillingEvent(event: BillingEventId, customerId: string, state: ObservedBilling): Promise<ApplyEventResult>;

  /**
   * True when deleteAccountData deleted the account of this customer (and nobody linked it since): the only proof that
   * a customer without a billing record belongs to a deleted account. Keeps a hash of the customer id and the time only.
   */
  isDeletedCustomer(customerId: string): Promise<boolean>;

  /**
   * Deletes recorded events received before `before` (ISO 8601), the oldest first, at most `limit`; returns how many. A replay of a
   * pruned event is applied as what Stripe says then, read after the stored state, so it can never bring an old state back.
   */
  pruneStripeEvents(before: string, limit: number): Promise<number>;

  /** Stores a new API key's hash, at most MAX_API_KEYS active keys per account. Atomic across instances. Throws RangeError for invalid input. */
  createApiKey(accountId: string, input: NewApiKey): Promise<CreateApiKeyResult>;
  /** The account's active keys, oldest first. Empty for an id that is not a UUID. */
  listApiKeys(accountId: string): Promise<ApiKey[]>;
  /** Revokes one key of the account: its row is deleted, so the key is unknown from then on. False when there was none. */
  revokeApiKey(accountId: string, keyId: string): Promise<boolean>;
  /** The account of a key by its hash, or null (unknown, revoked or malformed). */
  findApiKeyAccount(keyHash: string): Promise<string | null>;
}

export { MAX_API_KEYS, CLAIM_LAPSE_AFTER, CLAIM_RECHECK_AFTER_S, CLAIM_SLOW_AFTER_S, CLAIM_SLOW_RECHECK_AFTER_S, MAX_PENDING_CLAIMS, MAX_SAVED_REPORTS } from "./limits";
/** A score/v1 report is a few kilobytes; this bound only refuses something that is not one. */
export const MAX_REPORT_BYTES = 256 * 1024;
/** The stored form of a 12-page snapshot is at most about 240 KB of text and its records; a larger one than this cannot be published. */
export const MAX_PUBLISHED_SNAPSHOT_BYTES = 2 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** True for a lower-case UUID (an account or saved report id). */
export function isUuid(id: string): boolean {
  return UUID.test(id);
}

export function requireAccountId(accountId: string): string {
  if (!isUuid(accountId)) throw new RangeError("accountId must be a UUID");
  return accountId;
}

/** The token rule of the contract above (create and Start over): a known method and a SHA-256 hex hash. */
export function requireClaimToken(input: Omit<NewClaimInput, "host">): void {
  if (input.method !== "meta" && input.method !== "dns") throw new RangeError("method must be meta or dns");
  if (typeof input.tokenHash !== "string" || !SHA256_HEX_PATTERN.test(input.tokenHash)) throw new RangeError("tokenHash must be SHA-256 hex");
}

function requireHost(host: unknown): void {
  if (typeof host !== "string" || !isNormalizedHost(host)) throw new RangeError("host must be a lower-case host name");
}

/** The create rule of the contract above: a normalized host (isNormalizedHost) and requireClaimToken. */
export function requireNewClaim(input: NewClaimInput): void {
  requireHost(input.host);
  requireClaimToken(input);
}

/** A plain object of at most `max` bytes as JSON. */
function requireObject(name: string, value: unknown, max: number): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new RangeError(`${name} must be an object`);
  if (jsonBytes(value) > max) throw new RangeError(`${name} is too large`);
}

/** Bytes of `value` as JSON (what the size limits count). */
export function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

export function requireTime(name: string, value: unknown): string {
  const ms = typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isFinite(ms)) throw new RangeError(`${name} must be an ISO date and time`);
  return new Date(ms).toISOString();
}

/** The publish rule of the contract above. Returns the normalized times (ISO 8601). */
export function requirePublishInput(input: PublishSiteInput): { fetchedAt: string; now: string } {
  requireHost(input.host);
  requireObject("snapshot", input.snapshot, MAX_PUBLISHED_SNAPSHOT_BYTES);
  requireObject("report", input.report, MAX_REPORT_BYTES);
  return { fetchedAt: requireTime("fetchedAt", input.fetchedAt), now: requireTime("now", input.now) };
}

export function requireRefreshError(code: string): void {
  if (!(REFRESH_ERRORS as readonly string[]).includes(code)) throw new RangeError("unknown refresh error code");
}

/** The save rule of the contract above. Returns the normalized fetch time (ISO 8601). */
export function requireSaveInput(input: SaveReportInput): string {
  const { host, report, fetchedAt } = input;
  if (typeof host !== "string" || host.length === 0 || host.length > 253) throw new RangeError("host must be 1 to 253 characters");
  requireObject("report", report, MAX_REPORT_BYTES);
  return requireTime("fetchedAt", fetchedAt);
}

const CUSTOMER_ID = /^cus_\w{1,200}$/;
const EVENT_ID = /^evt_\w{1,200}$/;
const SUBSCRIPTION_ID = /^sub_\w{1,200}$/;
const STATUS = /^[a-z_]{1,40}$/;
const EVENT_TYPE = /^[a-z0-9_.]{1,100}$/;

export const isCustomerId = (id: unknown): id is string => typeof id === "string" && CUSTOMER_ID.test(id);

export function requireCustomerId(id: string): string {
  if (!isCustomerId(id)) throw new RangeError("customerId must be a Stripe customer id");
  return id;
}

export function requireBillingEvent(event: BillingEventId): void {
  if (!EVENT_ID.test(event.id)) throw new RangeError("event id must be a Stripe event id");
  if (!EVENT_TYPE.test(event.type)) throw new RangeError("event type is not valid");
}

/** The state rule of the contract above. Returns the state with normalized times (ISO 8601). */
export function requireBillingState(state: ObservedBilling): ObservedBilling {
  if (!PLANS.some((p) => p.id === state.plan)) throw new RangeError("plan must be a plan id");
  if (!STATUS.test(state.status)) throw new RangeError("status is not valid");
  if (state.subscriptionId !== null && !SUBSCRIPTION_ID.test(state.subscriptionId)) throw new RangeError("subscriptionId must be a Stripe subscription id");
  return {
    plan: state.plan,
    status: state.status,
    currentPeriodEnd: state.currentPeriodEnd === null ? null : requireTime("currentPeriodEnd", state.currentPeriodEnd),
    cancelAtPeriodEnd: state.cancelAtPeriodEnd === true,
    subscriptionId: state.subscriptionId,
    unpaidSince: state.unpaidSince === null ? null : requireTime("unpaidSince", state.unpaidSince),
    observedAt: requireTime("observedAt", state.observedAt),
  };
}

/** The API key rule of the contract above: a SHA-256 hex hash and four hex characters. */
export function requireApiKey(input: NewApiKey): void {
  if (!SHA256_HEX_PATTERN.test(input.keyHash)) throw new RangeError("keyHash must be SHA-256 hex");
  if (!/^[0-9a-f]{4}$/.test(input.hint)) throw new RangeError("hint must be four hex characters");
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
