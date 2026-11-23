import { sha256Hex, newToken, SHA256_HEX_PATTERN } from "@/lib/security/tokens";
import { serviceCall, serviceClient, type ServiceClientSource } from "@/lib/supabase/client";
import {
  AccountDataUnavailable,
  CLAIM_LAPSE_AFTER,
  isUuid,
  MAX_PENDING_CLAIMS,
  MAX_SAVED_REPORTS,
  normalizeEmail,
  requireAccountId,
  requireClaimInput,
  requireEmail,
  requireSaveInput,
  scoreOf,
  type AccountData,
  type Claim,
  type ClaimResult,
  type ClaimStatus,
  type NotifySignup,
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
  last_result: ClaimResult | null;
  last_detail: number | null;
}

/** The answer of the claim functions (supabase/migrations/*_claims.sql). */
interface ClaimAnswer {
  outcome: string;
  claim?: ClaimRow;
  moved_from?: string[];
}

const iso = (t: string) => new Date(t).toISOString();
const isoOrNull = (t: string | null) => (t === null ? null : iso(t));
const CLAIM_COLUMNS = "id, account_id, host, method, token_hash, status, created_at, verified_at, last_checked_at, failures, superseded_at, last_result, last_detail";

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
    lastResult: row.last_result,
    lastDetail: row.last_detail,
  };
}
const SUMMARY = "id, host, fetched_at, created_at, score:report->score";

function summary(row: SavedReportRow, score: unknown): SavedReportSummary {
  return { id: row.id, host: row.host, score: scoreOf({ score }), fetchedAt: iso(row.fetched_at), savedAt: iso(row.created_at) };
}

export function createSupabaseAccountData(source: ServiceClientSource): AccountData {
  const client = serviceClient(source);
  const notify = () => client.from("notify_signups");
  const profiles = () => client.from("account_profiles");
  const reports = () => client.from("saved_reports");
  const claims = () => client.from("site_claims");
  const call = <T>(operation: string, request: () => PromiseLike<{ data: T | null; error: { code?: string } | null }>) =>
    serviceCall<T>({ service: "accounts", operation }, request, (code) => new AccountDataUnavailable(operation, code));
  /** One claim function call; the claim it answers with, when the outcome carries one. */
  async function claimRpc(operation: string, fn: string, args: Record<string, unknown>): Promise<{ outcome: string; claim: Claim | null; movedFrom: string[] }> {
    const answer = await call<ClaimAnswer>(operation, () => client.rpc(fn, args));
    if (!answer || typeof answer.outcome !== "string") throw new AccountDataUnavailable(operation, "no_answer");
    return { outcome: answer.outcome, claim: answer.claim ? claimOf(answer.claim) : null, movedFrom: answer.moved_from ?? [] };
  }
  /** The claim of an outcome that must carry one. */
  const withClaim = (operation: string, claim: Claim | null): Claim => {
    if (!claim) throw new AccountDataUnavailable(operation, "no_claim");
    return claim;
  };

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

    async deleteAccountData(rawId) {
      const accountId = requireAccountId(rawId);
      // One database function, one transaction (supabase/migrations/*_delete_account_data.sql).
      await call("deleteAccountData", () => client.rpc("delete_account_data", { p_account_id: accountId }));
    },

    async createClaim(rawId, input) {
      const accountId = requireAccountId(rawId);
      requireClaimInput(input);
      const r = await claimRpc("createClaim", "create_claim", { p_account_id: accountId, p_host: input.host, p_method: input.method, p_token_hash: input.tokenHash, p_max_pending: MAX_PENDING_CLAIMS });
      if (r.outcome === "full") return { outcome: "full" };
      if (r.outcome === "created" || r.outcome === "exists") return { outcome: r.outcome, claim: withClaim("createClaim", r.claim) };
      throw new AccountDataUnavailable("createClaim", "bad_outcome");
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
      requireClaimInput(input, false);
      if (!isUuid(claimId)) return { outcome: "missing" };
      const r = await claimRpc("restartClaim", "restart_claim", { p_claim_id: claimId, p_account_id: accountId, p_method: input.method, p_token_hash: input.tokenHash, p_max_pending: MAX_PENDING_CLAIMS });
      if (r.outcome === "full" || r.outcome === "missing") return { outcome: r.outcome };
      if (r.outcome === "restarted" || r.outcome === "verified" || r.outcome === "superseded") return { outcome: r.outcome, claim: withClaim("restartClaim", r.claim) };
      throw new AccountDataUnavailable("restartClaim", "bad_outcome");
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
      });
      if (r.outcome === "missing") return { outcome: "missing" };
      if (r.outcome === "updated" || r.outcome === "stale" || r.outcome === "superseded") return { outcome: r.outcome, claim: withClaim("recordClaimFailure", r.claim) };
      throw new AccountDataUnavailable("recordClaimFailure", "bad_outcome");
    },

    async verifyClaim(claimId, input) {
      if (!isUuid(claimId)) return { outcome: "missing" };
      // One database function, one transaction: the host moves with the verification (supabase/migrations/*_claims.sql).
      const r = await claimRpc("verifyClaim", "verify_claim", { p_claim_id: claimId, p_token_hash: input.tokenHash, p_now: iso(input.checkedAt) });
      if (r.outcome === "missing") return { outcome: "missing" };
      if (r.outcome === "verified") return { outcome: "verified", claim: withClaim("verifyClaim", r.claim), movedFrom: r.movedFrom };
      if (r.outcome === "stale" || r.outcome === "superseded") return { outcome: r.outcome, claim: withClaim("verifyClaim", r.claim) };
      throw new AccountDataUnavailable("verifyClaim", "bad_outcome");
    },

    async listClaimsDueForRecheck(checkedBefore, limit) {
      const cutoff = iso(checkedBefore);
      const rows = await call<ClaimRow[]>("listClaimsDueForRecheck", () =>
        claims()
          .select(CLAIM_COLUMNS)
          .in("status", ["verified", "lapsed"])
          .or(`last_checked_at.is.null,last_checked_at.lt.${cutoff}`)
          .order("last_checked_at", { ascending: true, nullsFirst: true })
          .order("id", { ascending: true })
          .limit(Math.max(0, limit)),
      );
      return (rows ?? []).map(claimOf);
    },

    async deleteClaim(accountId, claimId) {
      if (!isUuid(accountId) || !isUuid(claimId)) return false;
      // published_sites rows of the claim go with it (claim_id ... on delete cascade).
      const rows = await call<{ id: string }[]>("deleteClaim", () => claims().delete().eq("account_id", accountId).eq("id", claimId).select("id"));
      return (rows ?? []).length > 0;
    },
  };
}
