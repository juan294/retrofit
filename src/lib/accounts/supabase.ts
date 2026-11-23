import { sha256Hex, newToken, SHA256_HEX_PATTERN } from "@/lib/security/tokens";
import { serviceCall, serviceClient, type ServiceClientSource } from "@/lib/supabase/client";
import {
  AccountDataUnavailable,
  isUuid,
  MAX_SAVED_REPORTS,
  normalizeEmail,
  requireAccountId,
  requireEmail,
  requireSaveInput,
  scoreOf,
  type AccountData,
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

const iso = (t: string) => new Date(t).toISOString();
const SUMMARY = "id, host, fetched_at, created_at, score:report->score";

function summary(row: SavedReportRow, score: unknown): SavedReportSummary {
  return { id: row.id, host: row.host, score: scoreOf({ score }), fetchedAt: iso(row.fetched_at), savedAt: iso(row.created_at) };
}

export function createSupabaseAccountData(source: ServiceClientSource): AccountData {
  const client = serviceClient(source);
  const notify = () => client.from("notify_signups");
  const profiles = () => client.from("account_profiles");
  const reports = () => client.from("saved_reports");
  const call = <T>(operation: string, request: () => PromiseLike<{ data: T | null; error: { code?: string } | null }>) =>
    serviceCall<T>({ service: "accounts", operation }, request, (code) => new AccountDataUnavailable(operation, code));

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
  };
}
