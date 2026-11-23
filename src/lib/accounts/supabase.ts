import { sha256Hex, newToken, SHA256_HEX_PATTERN } from "@/lib/security/tokens";
import { serviceCall, serviceClient, type ServiceClientSource } from "@/lib/supabase/client";
import { AccountDataUnavailable, normalizeEmail, requireEmail, type AccountData, type NotifySignup } from "./data";

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

const iso = (t: string) => new Date(t).toISOString();

export function createSupabaseAccountData(source: ServiceClientSource): AccountData {
  const client = serviceClient(source);
  const notify = () => client.from("notify_signups");
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
  };
}
