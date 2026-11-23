import { sha256Hex, newToken, SHA256_HEX_PATTERN } from "@/lib/security/tokens";
import type { PlanId } from "@/lib/billing/plans";
import type { AgentSnapshot } from "@/lib/snapshot/types";
import { isNormalizedHost } from "@/lib/fetch/url";
import { serviceCall, serviceClient, type ServiceClientSource } from "@/lib/supabase/client";
import {
  AccountDataUnavailable,
  CLAIM_LAPSE_AFTER,
  CLAIM_RECHECK_AFTER_S,
  CLAIM_SLOW_AFTER_S,
  CLAIM_SLOW_RECHECK_AFTER_S,
  isUuid,
  MAX_API_KEYS,
  MAX_PENDING_CLAIMS,
  MAX_SAVED_REPORTS,
  normalizeEmail,
  isCustomerId,
  requireAccountId,
  requireApiKey,
  requireBillingEvent,
  requireBillingState,
  requireClaimToken,
  requireCustomerId,
  requireNewClaim,
  requireEmail,
  requirePublishInput,
  requireRefreshError,
  requireSaveInput,
  scoreOf,
  type AccountData,
  type ApiKey,
  type ApplyBillingResult,
  type BillingRecord,
  type Claim,
  type ClaimResult,
  type ClaimStatus,
  type NotifySignup,
  type ObservedBilling,
  type PublicSite,
  type PublishedSite,
  type RefreshError,
  type SavedReportSummary,
} from "./data";

/**
 * Supabase AccountData (production). Server only: it holds the service role
 * key, so never import it from client code. Each operation is one or two
 * PostgREST table calls on supabase/migrations/*_accounts.sql; the tables'
 * unique constraints make the writes atomic.
 *
 * A failed call logs `[TABLE_FALLBACK]` at ERROR with the operation and the
 * error code only (never an email address, a token, a hash or the key) and
 * throws AccountDataUnavailable. There is no fallback: callers fail closed.
 */

interface NotifyRow {
  email: string;
  marketing_consent: boolean;
  created_at: string;
  unsubscribed_at: string | null;
}

interface SavedReportRow {
  id: string;
  host: string;
  fetched_at: string;
  created_at: string;
  /** `report->score` (the list) or the whole report (one report). */
  score?: unknown;
  report?: Record<string, unknown>;
}

interface ClaimRow {
  id: string;
  account_id: string;
  host: string;
  method: "meta" | "dns";
  token_hash: string;
  status: ClaimStatus;
  created_at: string;
  verified_at: string | null;
  last_checked_at: string | null;
  failures: number;
  superseded_at: string | null;
  lapsed_at: string | null;
  last_result: ClaimResult | null;
  last_detail: number | null;
}

interface PublicRow {
  host: string;
  score: unknown;
  fetched_at: string;
  published_at: string;
  refreshed_at: string;
  /** Only with public_site's part `report` or `snapshot`. */
  report?: Record<string, unknown>;
  snapshot?: AgentSnapshot;
}

interface PublishedRow extends PublicRow {
  claim_id: string;
  last_refresh_error: RefreshError | null;
}

/** The answer of the claim functions (supabase/migrations/*_claims.sql). */
interface ClaimAnswer {
  outcome: string;
  claim?: ClaimRow;
  moved_from?: string[];
}

interface BillingRow {
  account_id: string;
  stripe_customer_id: string;
  plan: PlanId;
  status: string;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  subscription_id: string | null;
  unpaid_since: string | null;
  state_at: string | null;
}

/** The answer of the billing functions (supabase/migrations/*_billing.sql). */
interface BillingAnswer {
  outcome: string;
  billing?: BillingRow;
}

interface ApiKeyRow {
  id: string;
  hint: string | null;
  created_at: string;
}

const iso = (t: string) => new Date(t).toISOString();
const isoOrNull = (t: string | null) => (t === null ? null : iso(t));
const CLAIM_COLUMNS = "id, account_id, host, method, token_hash, status, created_at, verified_at, last_checked_at, failures, superseded_at, lapsed_at, last_result, last_detail";

function claimOf(row: ClaimRow): Claim {
  return {
    id: row.id,
    accountId: row.account_id,
    host: row.host,
    method: row.method,
    tokenHash: row.token_hash,
    status: row.status,
    createdAt: iso(row.created_at),
    verifiedAt: isoOrNull(row.verified_at),
    lastCheckedAt: isoOrNull(row.last_checked_at),
    failures: row.failures,
    supersededAt: isoOrNull(row.superseded_at),
    lapsedAt: isoOrNull(row.lapsed_at),
    lastResult: row.last_result,
    lastDetail: row.last_detail,
  };
}
const SUMMARY = "id, host, fetched_at, created_at, score:report->score";

const PUBLISHED_COLUMNS = "host, claim_id, fetched_at, published_at, refreshed_at, last_refresh_error, score";

const BILLING_COLUMNS = "account_id, stripe_customer_id, plan, status, current_period_end, cancel_at_period_end, subscription_id, unpaid_since, state_at";

function billingOf(row: BillingRow): BillingRecord {
  return {
    accountId: row.account_id,
    customerId: row.stripe_customer_id,
    plan: row.plan,
    status: row.status,
    currentPeriodEnd: isoOrNull(row.current_period_end),
    cancelAtPeriodEnd: row.cancel_at_period_end,
    subscriptionId: row.subscription_id,
    unpaidSince: isoOrNull(row.unpaid_since),
    stateAt: isoOrNull(row.state_at),
  };
}

const apiKeyOf = (row: ApiKeyRow): ApiKey => ({ id: row.id, hint: row.hint, createdAt: iso(row.created_at) });

function publicSite(row: PublicRow): PublicSite {
  return { host: row.host, score: scoreOf({ score: row.score }), fetchedAt: iso(row.fetched_at), publishedAt: iso(row.published_at), refreshedAt: iso(row.refreshed_at) };
}

function publishedSite(row: PublishedRow): PublishedSite {
  return { ...publicSite(row), claimId: row.claim_id, lastRefreshError: row.last_refresh_error };
}

function summary(row: SavedReportRow, score: unknown): SavedReportSummary {
  return { id: row.id, host: row.host, score: scoreOf({ score }), fetchedAt: iso(row.fetched_at), savedAt: iso(row.created_at) };
}

export function createSupabaseAccountData(source: ServiceClientSource): AccountData {
  const client = serviceClient(source);
  const notify = () => client.from("notify_signups");
  const profiles = () => client.from("account_profiles");
  const reports = () => client.from("saved_reports");
  const claims = () => client.from("site_claims");
  const published = () => client.from("published_sites");
  const billing = () => client.from("billing_customers");
  const apiKeys = () => client.from("api_keys");
  const call = <T>(operation: string, request: () => PromiseLike<{ data: T | null; error: { code?: string } | null }>) =>
    serviceCall<T>({ service: "accounts", operation }, request, (code) => new AccountDataUnavailable(operation, code));
  /**
   * One claim function call. `carry`: the outcomes that answer with the claim; `bare`: those that do not.
   * Any other outcome, or a carrying outcome without its claim, is AccountDataUnavailable.
   */
  async function claimRpc<C extends string, B extends string = never>(
    operation: string,
    fn: string,
    args: Record<string, unknown>,
    carry: readonly C[],
    bare: readonly B[] = [],
  ): Promise<{ readonly outcome: C; readonly claim: Claim; readonly movedFrom: string[] } | { readonly outcome: B }> {
    const answer = await call<ClaimAnswer>(operation, () => client.rpc(fn, args));
    const outcome = answer?.outcome;
    if ((bare as readonly string[]).includes(outcome as string)) return { outcome: outcome as B };
    if (!(carry as readonly string[]).includes(outcome as string) || !answer?.claim) throw new AccountDataUnavailable(operation, "bad_outcome");
    return { outcome: outcome as C, claim: claimOf(answer.claim), movedFrom: answer.moved_from ?? [] };
  }

  /** One read of the one public rule (supabase/migrations/*_publishing.sql public_site), with the part the caller needs. */
  async function publicRow(operation: string, host: string, part: "site" | "report" | "snapshot"): Promise<PublicRow | null> {
    if (!isNormalizedHost(host)) return null;
    return call<PublicRow>(operation, () => client.rpc("public_site", { p_host: host, p_part: part }));
  }

  const stateArgs = (customerId: string, s: ObservedBilling) => ({
    p_customer_id: customerId,
    p_plan: s.plan,
    p_status: s.status,
    p_current_period_end: s.currentPeriodEnd,
    p_cancel_at_period_end: s.cancelAtPeriodEnd,
    p_subscription_id: s.subscriptionId,
    p_unpaid_since: s.unpaidSince,
    p_observed_at: s.observedAt,
  });
  /** The applied, stale or unknown answer of a billing function; anything else is AccountDataUnavailable. */
  function applied(operation: string, answer: BillingAnswer | null): ApplyBillingResult {
    if (answer?.outcome === "unknown") return { outcome: "unknown" };
    if ((answer?.outcome === "applied" || answer?.outcome === "stale") && answer.billing) return { outcome: answer.outcome, billing: billingOf(answer.billing) };
    throw new AccountDataUnavailable(operation, "bad_outcome");
  }

  return {
    async addNotifySignup(rawEmail, consent = false) {
      const email = requireEmail(rawEmail);
      const token = newToken();
      // INSERT ... ON CONFLICT (email) DO NOTHING RETURNING id: one row only when this call created it.
      const created = await call("addNotifySignup", () =>
        notify().upsert({ email, marketing_consent: consent === true, unsubscribe_token_hash: sha256Hex(token) }, { onConflict: "email", ignoreDuplicates: true }).select("id"),
      );
      return (created ?? []).length === 1 ? { created: true, unsubscribeToken: token } : { created: false, unsubscribeToken: null };
    },

    async findNotifySignup(rawEmail) {
      const email = normalizeEmail(rawEmail);
      if (email === null) return null;
      const row = await call<NotifyRow>("findNotifySignup", () => notify().select("email, marketing_consent, created_at, unsubscribed_at").eq("email", email).maybeSingle());
      if (!row) return null;
      const signup: NotifySignup = {
        email: row.email,
        marketingConsent: row.marketing_consent,
        createdAt: iso(row.created_at),
        unsubscribedAt: row.unsubscribed_at === null ? null : iso(row.unsubscribed_at),
      };
      return signup;
    },

    async unsubscribe(tokenHash) {
      if (!SHA256_HEX_PATTERN.test(tokenHash)) return "unknown";
      // Only a subscribed row changes, so the first time is kept and two concurrent calls record it once.
      const changed = await call("unsubscribe", () =>
        notify().update({ unsubscribed_at: new Date().toISOString() }).eq("unsubscribe_token_hash", tokenHash).is("unsubscribed_at", null).select("id"),
      );
      if ((changed ?? []).length > 0) return "unsubscribed";
      const existing = await call("unsubscribe", () => notify().select("id").eq("unsubscribe_token_hash", tokenHash).maybeSingle());
      return existing ? "already" : "unknown";
    },

    async ensureProfile(rawId) {
      const accountId = requireAccountId(rawId);
      // INSERT ... ON CONFLICT (account_id) DO NOTHING: a repeat sign-in keeps the first creation time.
      await call("ensureProfile", () => profiles().upsert({ account_id: accountId }, { onConflict: "account_id", ignoreDuplicates: true }));
    },

    async getProfile(accountId) {
      if (!isUuid(accountId)) return null;
      const row = await call<{ created_at: string }>("getProfile", () => profiles().select("created_at").eq("account_id", accountId).maybeSingle());
      return row ? { createdAt: iso(row.created_at) } : null;
    },

    async saveReport(rawId, input) {
      const accountId = requireAccountId(rawId);
      const fetchedAt = requireSaveInput(input);
      // One database function serializes the account's saves (supabase/migrations/*_saved_reports_once.sql).
      const rows = await call<(SavedReportRow & { outcome: "created" | "existing" | "full" })[]>("saveReport", () =>
        client.rpc("save_report", { p_account_id: accountId, p_host: input.host, p_report: input.report, p_fetched_at: fetchedAt, p_max: MAX_SAVED_REPORTS }),
      );
      const row = rows?.[0];
      if (!row) throw new AccountDataUnavailable("saveReport", "no_row");
      if (row.outcome === "full") return { outcome: "full" };
      return { outcome: row.outcome, report: summary(row, row.score) };
    },

    async listSavedReports(accountId) {
      if (!isUuid(accountId)) return [];
      const rows = await call<SavedReportRow[]>("listSavedReports", () =>
        reports().select(SUMMARY).eq("account_id", accountId).order("created_at", { ascending: false }).order("id", { ascending: false }).limit(MAX_SAVED_REPORTS),
      );
      return (rows ?? []).map((r) => summary(r, r.score));
    },

    async getSavedReport(accountId, reportId) {
      if (!isUuid(accountId) || !isUuid(reportId)) return null;
      const row = await call<SavedReportRow>("getSavedReport", () => reports().select("id, host, fetched_at, created_at, report").eq("account_id", accountId).eq("id", reportId).maybeSingle());
      if (!row?.report) return null;
      return { ...summary(row, row.report.score), report: row.report };
    },

    async getSavedReportHost(accountId, reportId) {
      if (!isUuid(accountId) || !isUuid(reportId)) return null;
      const row = await call<{ host: string }>("getSavedReportHost", () => reports().select("host").eq("account_id", accountId).eq("id", reportId).maybeSingle());
      return row?.host ?? null;
    },

    async deleteAccountData(rawId) {
      const accountId = requireAccountId(rawId);
      // One database function, one transaction (supabase/migrations/*_delete_account_data.sql).
      await call("deleteAccountData", () => client.rpc("delete_account_data", { p_account_id: accountId }));
    },

    async createClaim(rawId, input) {
      const accountId = requireAccountId(rawId);
      requireNewClaim(input);
      const args = { p_account_id: accountId, p_host: input.host, p_method: input.method, p_token_hash: input.tokenHash, p_max_pending: MAX_PENDING_CLAIMS };
      const r = await claimRpc("createClaim", "create_claim", args, ["created", "exists"], ["full"]);
      return "claim" in r ? { outcome: r.outcome, claim: r.claim } : r;
    },

    async listClaims(accountId) {
      if (!isUuid(accountId)) return [];
      const rows = await call<ClaimRow[]>("listClaims", () => claims().select(CLAIM_COLUMNS).eq("account_id", accountId).order("created_at", { ascending: true }).order("id", { ascending: true }));
      return (rows ?? []).map(claimOf);
    },

    async getClaim(accountId, claimId) {
      if (!isUuid(accountId) || !isUuid(claimId)) return null;
      const row = await call<ClaimRow>("getClaim", () => claims().select(CLAIM_COLUMNS).eq("account_id", accountId).eq("id", claimId).maybeSingle());
      return row ? claimOf(row) : null;
    },

    async restartClaim(rawId, claimId, input) {
      const accountId = requireAccountId(rawId);
      requireClaimToken(input);
      if (!isUuid(claimId)) return { outcome: "missing" };
      const args = { p_claim_id: claimId, p_account_id: accountId, p_method: input.method, p_token_hash: input.tokenHash, p_max_pending: MAX_PENDING_CLAIMS };
      const r = await claimRpc("restartClaim", "restart_claim", args, ["restarted", "verified", "superseded"], ["full", "missing"]);
      if (!("claim" in r)) return r;
      return r.outcome === "restarted" ? { outcome: "restarted", claim: r.claim } : { outcome: r.outcome, claim: r.claim };
    },

    async recordClaimFailure(claimId, input) {
      if (!isUuid(claimId)) return { outcome: "missing" };
      const r = await claimRpc("recordClaimFailure", "record_claim_failure", {
        p_claim_id: claimId,
        p_token_hash: input.tokenHash,
        p_result: input.result,
        p_detail: input.detail,
        p_now: iso(input.checkedAt),
        p_lapse_after: CLAIM_LAPSE_AFTER,
      }, ["updated", "stale", "superseded"], ["missing"]);
      return "claim" in r ? { outcome: r.outcome, claim: r.claim } : r;
    },

    async verifyClaim(claimId, input) {
      if (!isUuid(claimId)) return { outcome: "missing" };
      // One database function, one transaction: the host moves with the verification (supabase/migrations/*_claims.sql).
      const r = await claimRpc("verifyClaim", "verify_claim", { p_claim_id: claimId, p_token_hash: input.tokenHash, p_now: iso(input.checkedAt) }, ["verified", "stale", "superseded"], ["missing"]);
      if (!("claim" in r)) return r;
      return r.outcome === "verified" ? { outcome: "verified", claim: r.claim, movedFrom: r.movedFrom } : { outcome: r.outcome, claim: r.claim };
    },

    async listClaimsDueForRecheck(rawNow, limit) {
      const now = Date.parse(iso(rawNow));
      const before = (s: number) => new Date(now - s * 1000).toISOString();
      // One database function applies the recheck policy and order (supabase/migrations/*_claims.sql claims_due).
      const rows = await call<ClaimRow[]>("listClaimsDueForRecheck", () =>
        client.rpc("claims_due", { p_checked_before: before(CLAIM_RECHECK_AFTER_S), p_slow_lapsed_before: before(CLAIM_SLOW_AFTER_S), p_slow_checked_before: before(CLAIM_SLOW_RECHECK_AFTER_S), p_limit: Math.max(0, limit) }),
      );
      return (rows ?? []).map(claimOf);
    },

    async deleteClaim(accountId, claimId) {
      if (!isUuid(accountId) || !isUuid(claimId)) return false;
      // published_sites rows of the claim go with it (claim_id ... on delete cascade).
      const rows = await call<{ id: string }[]>("deleteClaim", () => claims().delete().eq("account_id", accountId).eq("id", claimId).select("id"));
      return (rows ?? []).length > 0;
    },

    async publishSite(rawId, input) {
      const accountId = requireAccountId(rawId);
      const { fetchedAt, now } = requirePublishInput(input);
      // One database function, one transaction: the claim is checked again under the host's lock (*_publishing.sql publish_site).
      const answer = await call<{ outcome: string; site?: PublishedRow }>("publishSite", () =>
        client.rpc("publish_site", { p_account_id: accountId, p_host: input.host, p_snapshot: input.snapshot, p_report: input.report, p_fetched_at: fetchedAt, p_now: now }),
      );
      const outcome = answer?.outcome;
      if (outcome === "no_claim" || outcome === "not_verified") return { outcome };
      if ((outcome !== "published" && outcome !== "refreshed" && outcome !== "not_newer") || !answer?.site) throw new AccountDataUnavailable("publishSite", "bad_outcome");
      return { outcome, site: publishedSite(answer.site) };
    },

    async recordRefreshError(accountId, host, code) {
      requireRefreshError(code);
      if (!isUuid(accountId)) return null;
      const rows = await call<PublishedRow[]>("recordRefreshError", () => published().update({ last_refresh_error: code }).eq("account_id", accountId).eq("host", host).select(PUBLISHED_COLUMNS));
      const row = rows?.[0];
      return row ? publishedSite(row) : null;
    },

    async unpublishSite(accountId, host) {
      if (!isUuid(accountId)) return false;
      const rows = await call<{ host: string }[]>("unpublishSite", () => published().delete().eq("account_id", accountId).eq("host", host).select("host"));
      return (rows ?? []).length > 0;
    },

    async listPublishedSites(accountId) {
      if (!isUuid(accountId)) return [];
      const rows = await call<PublishedRow[]>("listPublishedSites", () => published().select(PUBLISHED_COLUMNS).eq("account_id", accountId).order("host", { ascending: true }));
      return (rows ?? []).map(publishedSite);
    },

    async getPublicSite(host) {
      const row = await publicRow("getPublicSite", host, "site");
      return row && publicSite(row);
    },

    async getPublicReport(host) {
      const row = await publicRow("getPublicReport", host, "report");
      return row?.report ? { ...publicSite(row), report: row.report } : null;
    },

    async getPublicSnapshot(host) {
      const row = await publicRow("getPublicSnapshot", host, "snapshot");
      return row?.snapshot ? { ...publicSite(row), snapshot: row.snapshot } : null;
    },

    async listPublicHosts(limit) {
      return (await call<string[]>("listPublicHosts", () => client.rpc("public_hosts", { p_limit: Math.max(0, limit) }))) ?? [];
    },

    async getBilling(accountId) {
      if (!isUuid(accountId)) return null;
      const row = await call<BillingRow>("getBilling", () => billing().select(BILLING_COLUMNS).eq("account_id", accountId).maybeSingle());
      return row && billingOf(row);
    },

    async getBillingByCustomer(customerId) {
      if (!isCustomerId(customerId)) return null;
      const row = await call<BillingRow>("getBillingByCustomer", () => billing().select(BILLING_COLUMNS).eq("stripe_customer_id", customerId).maybeSingle());
      return row && billingOf(row);
    },

    async linkBillingCustomer(rawId, rawCustomer) {
      const accountId = requireAccountId(rawId);
      const customerId = requireCustomerId(rawCustomer);
      const answer = await call<BillingAnswer>("linkBillingCustomer", () => client.rpc("link_billing_customer", { p_account_id: accountId, p_customer_id: customerId }));
      const outcome = answer?.outcome;
      if (outcome === "taken" || outcome === "no_account") return { outcome };
      if ((outcome !== "linked" && outcome !== "existing") || !answer?.billing) throw new AccountDataUnavailable("linkBillingCustomer", "bad_outcome");
      return { outcome, billing: billingOf(answer.billing) };
    },

    async applyBillingState(rawCustomer, rawState) {
      const customerId = requireCustomerId(rawCustomer);
      const state = requireBillingState(rawState);
      return applied("applyBillingState", await call<BillingAnswer>("applyBillingState", () => client.rpc("apply_billing_state", stateArgs(customerId, state))));
    },

    async applyBillingEvent(event, rawCustomer, rawState) {
      requireBillingEvent(event);
      const customerId = requireCustomerId(rawCustomer);
      const state = requireBillingState(rawState);
      // One database function, one transaction: the event and its state together (supabase/migrations/*_billing.sql).
      const answer = await call<BillingAnswer>("applyBillingEvent", () => client.rpc("apply_billing_event", { p_event_id: event.id, p_type: event.type, ...stateArgs(customerId, state) }));
      return answer?.outcome === "duplicate" ? { outcome: "duplicate" } : applied("applyBillingEvent", answer);
    },

    async isDeletedCustomer(customerId) {
      if (!isCustomerId(customerId)) return false;
      const row = await call<{ deleted_at: string }>("isDeletedCustomer", () => client.from("deleted_customers").select("deleted_at").eq("customer_hash", sha256Hex(customerId)).maybeSingle());
      return row !== null;
    },

    async createApiKey(rawId, input) {
      const accountId = requireAccountId(rawId);
      requireApiKey(input);
      const answer = await call<ApiKeyRow & { outcome: string }>("createApiKey", () =>
        client.rpc("create_api_key", { p_account_id: accountId, p_key_hash: input.keyHash, p_hint: input.hint, p_max: MAX_API_KEYS }),
      );
      if (answer?.outcome === "full") return { outcome: "full" };
      if (answer?.outcome !== "created") throw new AccountDataUnavailable("createApiKey", "bad_outcome");
      return { outcome: "created", key: apiKeyOf(answer) };
    },

    async listApiKeys(accountId) {
      if (!isUuid(accountId)) return [];
      const rows = await call<ApiKeyRow[]>("listApiKeys", () =>
        apiKeys().select("id, hint, created_at").eq("account_id", accountId).is("revoked_at", null).order("created_at", { ascending: true }).order("id", { ascending: true }).limit(MAX_API_KEYS),
      );
      return (rows ?? []).map(apiKeyOf);
    },

    async revokeApiKey(accountId, keyId) {
      if (!isUuid(accountId) || !isUuid(keyId)) return false;
      const rows = await call<{ id: string }[]>("revokeApiKey", () =>
        apiKeys().update({ revoked_at: new Date().toISOString() }).eq("account_id", accountId).eq("id", keyId).is("revoked_at", null).select("id"),
      );
      return (rows ?? []).length > 0;
    },

    async findApiKeyAccount(keyHash) {
      if (!SHA256_HEX_PATTERN.test(keyHash)) return null;
      const row = await call<{ account_id: string }>("findApiKeyAccount", () => apiKeys().select("account_id").eq("key_hash", keyHash).is("revoked_at", null).maybeSingle());
      return row?.account_id ?? null;
    },
  };
}
