import { randomUUID } from "node:crypto";
import { systemClock, type Clock } from "@/lib/store/types";
import { newToken, sha256Hex, SHA256_HEX_PATTERN } from "@/lib/security/tokens";
import {
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
  type ClaimStatus,
  type NotifySignup,
  type SaveReportResult,
  type SavedReport,
  type SavedReportSummary,
} from "./data";

interface NotifyRow {
  readonly email: string;
  readonly marketingConsent: boolean;
  readonly unsubscribeTokenHash: string;
  readonly createdAt: number;
  unsubscribedAt: number | null;
}

interface SavedReportRow {
  readonly id: string;
  readonly accountId: string;
  readonly host: string;
  readonly report: Record<string, unknown>;
  readonly fetchedAt: string;
  readonly createdAt: number;
  /** Insertion order, so reports saved in the same millisecond still list newest first. */
  readonly seq: number;
}

interface ClaimRow {
  claim: Claim;
  /** The account that took the host over; null after that account's data is deleted. Never returned. */
  supersededBy: string | null;
  /** Insertion order, for oldest-first lists. */
  readonly seq: number;
}

/** Shared state. Two adapters over one backing model two server instances. */
export interface AccountMemoryBacking {
  /** Keyed by the normalized email. */
  readonly notify: Map<string, NotifyRow>;
  /** Profile creation times, keyed by account id. */
  readonly profiles: Map<string, number>;
  /** Keyed by report id. */
  readonly savedReports: Map<string, SavedReportRow>;
  /** Keyed by claim id. */
  readonly claims: Map<string, ClaimRow>;
}

export function createAccountMemoryBacking(): AccountMemoryBacking {
  return { notify: new Map(), profiles: new Map(), savedReports: new Map(), claims: new Map() };
}

let seq = 0;

function summary(row: SavedReportRow): SavedReportSummary {
  return { id: row.id, host: row.host, score: scoreOf(row.report), fetchedAt: row.fetchedAt, savedAt: iso(row.createdAt) };
}

export interface MemoryAccountDataOptions {
  clock?: Clock;
  backing?: AccountMemoryBacking;
}

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * In-memory AccountData. Like the memory Store, each operation yields once and
 * then runs synchronously, so concurrent callers interleave between operations
 * but never inside one.
 */
export function createMemoryAccountData(options: MemoryAccountDataOptions = {}): AccountData {
  const clock = options.clock ?? systemClock;
  const { notify, profiles, savedReports, claims } = options.backing ?? createAccountMemoryBacking();
  const accountClaims = (accountId: string) => [...claims.values()].filter((r) => r.claim.accountId === accountId).sort((x, y) => x.seq - y.seq);
  const pendingCount = (accountId: string) => accountClaims(accountId).filter((r) => r.claim.status === "pending").length;
  const copy = (claim: Claim): Claim => ({ ...claim });
  const update = (row: ClaimRow, change: Partial<Claim>): Claim => {
    row.claim = { ...row.claim, ...change };
    return copy(row.claim);
  };
  /** The checks of verifyClaim and recordClaimFailure: missing, terminal or a replaced token. */
  const checkable = (claimId: string, tokenHash: string): { row: ClaimRow } | { done: { outcome: "missing" } | { outcome: "stale" | "superseded"; claim: Claim } } => {
    const row = isUuid(claimId) ? claims.get(claimId) : undefined;
    if (!row) return { done: { outcome: "missing" } };
    if (row.claim.status === "superseded") return { done: { outcome: "superseded", claim: copy(row.claim) } };
    if (row.claim.tokenHash !== tokenHash) return { done: { outcome: "stale", claim: copy(row.claim) } };
    return { row };
  };
  const iso8601 = (at: string) => new Date(at).toISOString();

  async function op<R>(body: (now: number) => R): Promise<R> {
    await Promise.resolve();
    return body(clock());
  }

  return {
    async addNotifySignup(rawEmail, consent = false) {
      const email = requireEmail(rawEmail);
      return op((now) => {
        if (notify.has(email)) return { created: false, unsubscribeToken: null };
        const token = newToken();
        notify.set(email, { email, marketingConsent: consent === true, unsubscribeTokenHash: sha256Hex(token), createdAt: now, unsubscribedAt: null });
        return { created: true, unsubscribeToken: token };
      });
    },

    async findNotifySignup(rawEmail) {
      const email = normalizeEmail(rawEmail);
      return op((): NotifySignup | null => {
        const row = email === null ? undefined : notify.get(email);
        if (!row) return null;
        return { email: row.email, marketingConsent: row.marketingConsent, createdAt: iso(row.createdAt), unsubscribedAt: row.unsubscribedAt === null ? null : iso(row.unsubscribedAt) };
      });
    },

    async unsubscribe(tokenHash) {
      return op((now) => {
        if (!SHA256_HEX_PATTERN.test(tokenHash)) return "unknown";
        for (const row of notify.values()) {
          if (row.unsubscribeTokenHash !== tokenHash) continue;
          if (row.unsubscribedAt !== null) return "already";
          row.unsubscribedAt = now;
          return "unsubscribed";
        }
        return "unknown";
      });
    },

    async ensureProfile(rawId) {
      const accountId = requireAccountId(rawId);
      return op((now) => {
        if (!profiles.has(accountId)) profiles.set(accountId, now);
      });
    },

    async getProfile(accountId) {
      return op(() => {
        const createdAt = profiles.get(accountId);
        return createdAt === undefined ? null : { createdAt: iso(createdAt) };
      });
    },

    async saveReport(rawId, input) {
      const accountId = requireAccountId(rawId);
      const fetchedAt = requireSaveInput(input);
      return op((now): SaveReportResult => {
        const mine = [...savedReports.values()].filter((r) => r.accountId === accountId);
        const same = mine.find((r) => r.host === input.host && r.fetchedAt === fetchedAt);
        if (same) return { outcome: "existing", report: summary(same) };
        if (mine.length >= MAX_SAVED_REPORTS) return { outcome: "full" };
        const row: SavedReportRow = { id: randomUUID(), accountId, host: input.host, report: structuredClone(input.report), fetchedAt, createdAt: now, seq: ++seq };
        savedReports.set(row.id, row);
        return { outcome: "created", report: summary(row) };
      });
    },

    async listSavedReports(accountId) {
      return op(() =>
        [...savedReports.values()]
          .filter((r) => r.accountId === accountId)
          .sort((x, y) => y.createdAt - x.createdAt || y.seq - x.seq)
          .slice(0, MAX_SAVED_REPORTS)
          .map(summary),
      );
    },

    async getSavedReport(accountId, reportId) {
      return op((): SavedReport | null => {
        const row = isUuid(reportId) ? savedReports.get(reportId) : undefined;
        if (!row || row.accountId !== accountId) return null;
        return { ...summary(row), report: structuredClone(row.report) };
      });
    },

    async deleteAccountData(rawId) {
      const accountId = requireAccountId(rawId);
      // One synchronous step after the yield, so it is atomic like the database function.
      return op(() => {
        profiles.delete(accountId);
        for (const [id, row] of savedReports) if (row.accountId === accountId) savedReports.delete(id);
        for (const [id, row] of claims) if (row.claim.accountId === accountId) claims.delete(id);
        // As the auth user's deletion does (superseded_by ... on delete set null).
        for (const row of claims.values()) if (row.supersededBy === accountId) row.supersededBy = null;
      });
    },

    async createClaim(rawId, input) {
      const accountId = requireAccountId(rawId);
      requireClaimInput(input);
      return op((now) => {
        const same = accountClaims(accountId).find((r) => r.claim.host === input.host);
        if (same) return { outcome: "exists", claim: copy(same.claim) };
        if (pendingCount(accountId) >= MAX_PENDING_CLAIMS) return { outcome: "full" };
        const claim: Claim = {
          id: randomUUID(),
          accountId,
          host: input.host,
          method: input.method,
          tokenHash: input.tokenHash,
          status: "pending",
          createdAt: iso(now),
          verifiedAt: null,
          lastCheckedAt: null,
          failures: 0,
          supersededAt: null,
          lastResult: null,
          lastDetail: null,
        };
        claims.set(claim.id, { claim, supersededBy: null, seq: ++seq });
        return { outcome: "created", claim: copy(claim) };
      });
    },

    async listClaims(accountId) {
      return op(() => accountClaims(accountId).map((r) => copy(r.claim)));
    },

    async getClaim(accountId, claimId) {
      return op(() => {
        const row = isUuid(claimId) ? claims.get(claimId) : undefined;
        return row && row.claim.accountId === accountId ? copy(row.claim) : null;
      });
    },

    async restartClaim(rawId, claimId, input) {
      const accountId = requireAccountId(rawId);
      requireClaimInput(input, false);
      return op(() => {
        const row = isUuid(claimId) ? claims.get(claimId) : undefined;
        if (!row || row.claim.accountId !== accountId) return { outcome: "missing" };
        const { status } = row.claim;
        if (status === "verified" || status === "superseded") return { outcome: status, claim: copy(row.claim) };
        if (status !== "pending" && pendingCount(accountId) >= MAX_PENDING_CLAIMS) return { outcome: "full" };
        const claim = update(row, { method: input.method, tokenHash: input.tokenHash, status: "pending", verifiedAt: null, lastCheckedAt: null, failures: 0, lastResult: null, lastDetail: null });
        return { outcome: "restarted", claim };
      });
    },

    async recordClaimFailure(claimId, input) {
      const checkedAt = iso8601(input.checkedAt);
      return op(() => {
        const found = checkable(claimId, input.tokenHash);
        if ("done" in found) return found.done;
        const { row } = found;
        const failures = row.claim.failures + 1;
        const lapses = (row.claim.status === "verified" || row.claim.status === "lapsed") && failures >= CLAIM_LAPSE_AFTER;
        const status: ClaimStatus = lapses ? "lapsed" : row.claim.status;
        return { outcome: "updated", claim: update(row, { failures, status, lastCheckedAt: checkedAt, lastResult: input.result, lastDetail: input.detail }) };
      });
    },

    async verifyClaim(claimId, input) {
      const checkedAt = iso8601(input.checkedAt);
      return op(() => {
        const found = checkable(claimId, input.tokenHash);
        if ("done" in found) return found.done;
        const { row } = found;
        const movedFrom: string[] = [];
        for (const other of claims.values()) {
          if (other === row || other.claim.host !== row.claim.host || (other.claim.status !== "verified" && other.claim.status !== "lapsed")) continue;
          // Phase 4: the published site of `other` is paused here (its claim is no longer verified).
          update(other, { status: "superseded", supersededAt: checkedAt });
          other.supersededBy = row.claim.accountId;
          movedFrom.push(other.claim.accountId);
        }
        const verifiedAt = row.claim.status === "verified" ? row.claim.verifiedAt : checkedAt;
        const claim = update(row, { status: "verified", verifiedAt, lastCheckedAt: checkedAt, failures: 0, lastResult: "verified", lastDetail: null });
        return { outcome: "verified", claim, movedFrom };
      });
    },

    async listClaimsDueForRecheck(checkedBefore, limit) {
      const cutoff = Date.parse(checkedBefore);
      // Never checked sorts first, as in the database (nulls first).
      const checked = (c: Claim) => (c.lastCheckedAt === null ? 0 : Date.parse(c.lastCheckedAt));
      return op(() =>
        [...claims.values()]
          .map((r) => r.claim)
          .filter((c) => (c.status === "verified" || c.status === "lapsed") && checked(c) < cutoff)
          .sort((x, y) => checked(x) - checked(y))
          .slice(0, Math.max(0, limit))
          .map(copy),
      );
    },

    async deleteClaim(accountId, claimId) {
      return op(() => {
        const row = isUuid(claimId) ? claims.get(claimId) : undefined;
        if (!row || row.claim.accountId !== accountId) return false;
        claims.delete(claimId);
        return true;
      });
    },
  };
}
