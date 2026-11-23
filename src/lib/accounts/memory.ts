import { randomUUID } from "node:crypto";
import { systemClock, type Clock } from "@/lib/store/types";
import { newToken, sha256Hex, SHA256_HEX_PATTERN } from "@/lib/security/tokens";
import {
  CLAIM_LAPSE_AFTER,
  CLAIM_RECHECK_AFTER_S,
  CLAIM_SLOW_AFTER_S,
  CLAIM_SLOW_RECHECK_AFTER_S,
  isUuid,
  MAX_PENDING_CLAIMS,
  MAX_SAVED_REPORTS,
  normalizeEmail,
  requireAccountId,
  requireClaimToken,
  requireNewClaim,
  requireEmail,
  requirePublishInput,
  requireRefreshError,
  requireSaveInput,
  scoreOf,
  type AccountData,
  type Claim,
  type ClaimStatus,
  type NotifySignup,
  type PublicSite,
  type PublishedSite,
  type PublishSiteResult,
  type RefreshError,
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

interface PublishedRow {
  readonly host: string;
  readonly accountId: string;
  readonly claimId: string;
  readonly snapshot: Record<string, unknown>;
  readonly report: Record<string, unknown>;
  readonly fetchedAt: string;
  readonly publishedAt: string;
  readonly refreshedAt: string;
  lastRefreshError: RefreshError | null;
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
  /** Keyed by host. */
  readonly published: Map<string, PublishedRow>;
}

export function createAccountMemoryBacking(): AccountMemoryBacking {
  return { notify: new Map(), profiles: new Map(), savedReports: new Map(), claims: new Map(), published: new Map() };
}

let seq = 0;

function summary(row: SavedReportRow): SavedReportSummary {
  return { id: row.id, host: row.host, score: scoreOf(row.report), fetchedAt: row.fetchedAt, savedAt: iso(row.createdAt) };
}

export interface MemoryAccountDataOptions {
  clock?: Clock;
  backing?: AccountMemoryBacking;
}

/** ISO 8601 of a time in ms or of a date string. */
const iso = (t: number | string) => new Date(t).toISOString();

/**
 * In-memory AccountData. Like the memory Store, each operation yields once and
 * then runs synchronously, so concurrent callers interleave between operations
 * but never inside one.
 */
export function createMemoryAccountData(options: MemoryAccountDataOptions = {}): AccountData {
  const clock = options.clock ?? systemClock;
  const { notify, profiles, savedReports, claims, published } = options.backing ?? createAccountMemoryBacking();
  const accountClaims = (accountId: string) => [...claims.values()].filter((r) => r.claim.accountId === accountId).sort((x, y) => x.seq - y.seq);
  const pendingCount = (accountId: string) => accountClaims(accountId).filter((r) => r.claim.status === "pending").length;
  const copy = (claim: Claim): Claim => ({ ...claim });
  const update = (row: ClaimRow, change: Partial<Claim>): Claim => {
    row.claim = { ...row.claim, ...change };
    return copy(row.claim);
  };
  /** The account's claim `claimId`, or undefined (another account's, unknown or malformed). */
  const ownRow = (accountId: string, claimId: string): ClaimRow | undefined => {
    const row = isUuid(claimId) ? claims.get(claimId) : undefined;
    return row?.claim.accountId === accountId ? row : undefined;
  };
  /** The checks of verifyClaim and recordClaimFailure: missing, terminal or a replaced token. */
  const checkable = (claimId: string, tokenHash: string): { row: ClaimRow } | { done: { outcome: "missing" } | { outcome: "stale" | "superseded"; claim: Claim } } => {
    const row = isUuid(claimId) ? claims.get(claimId) : undefined;
    if (!row) return { done: { outcome: "missing" } };
    if (row.claim.status === "superseded") return { done: { outcome: "superseded", claim: copy(row.claim) } };
    if (row.claim.tokenHash !== tokenHash) return { done: { outcome: "stale", claim: copy(row.claim) } };
    return { row };
  };

  /** The account's publication of the host, or undefined. */
  const ownSite = (accountId: string, host: string): PublishedRow | undefined => {
    const row = published.get(host);
    return row?.accountId === accountId ? row : undefined;
  };
  /** The one public rule (AccountData getPublicSite; the database's site_is_public). */
  const isPublic = (row: PublishedRow): boolean => {
    const claim = claims.get(row.claimId)?.claim;
    return claim !== undefined && claim.status === "verified" && claim.accountId === row.accountId && claim.host === row.host;
  };
  const publicRow = (host: string): PublishedRow | null => {
    const row = published.get(host);
    return row && isPublic(row) ? row : null;
  };
  const publicSite = (row: PublishedRow): PublicSite => ({ host: row.host, score: scoreOf(row.report), fetchedAt: row.fetchedAt, publishedAt: row.publishedAt, refreshedAt: row.refreshedAt });
  const ownedSite = (row: PublishedRow): PublishedSite => ({ ...publicSite(row), claimId: row.claimId, lastRefreshError: row.lastRefreshError });

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

    async getSavedReportHost(accountId, reportId) {
      return op(() => {
        const row = isUuid(reportId) ? savedReports.get(reportId) : undefined;
        return row && row.accountId === accountId ? row.host : null;
      });
    },

    async deleteAccountData(rawId) {
      const accountId = requireAccountId(rawId);
      // One synchronous step after the yield, so it is atomic like the database function.
      return op(() => {
        profiles.delete(accountId);
        for (const [id, row] of savedReports) if (row.accountId === accountId) savedReports.delete(id);
        for (const [host, row] of published) if (row.accountId === accountId) published.delete(host);
        for (const [id, row] of claims) if (row.claim.accountId === accountId) claims.delete(id);
        // As the auth user's deletion does (superseded_by ... on delete set null).
        for (const row of claims.values()) if (row.supersededBy === accountId) row.supersededBy = null;
      });
    },

    async createClaim(rawId, input) {
      const accountId = requireAccountId(rawId);
      requireNewClaim(input);
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
          lapsedAt: null,
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
        const row = ownRow(accountId, claimId);
        return row ? copy(row.claim) : null;
      });
    },

    async restartClaim(rawId, claimId, input) {
      const accountId = requireAccountId(rawId);
      requireClaimToken(input);
      return op(() => {
        const row = ownRow(accountId, claimId);
        if (!row) return { outcome: "missing" };
        const { status } = row.claim;
        if (status === "verified" || status === "superseded") return { outcome: status, claim: copy(row.claim) };
        if (status !== "pending" && pendingCount(accountId) >= MAX_PENDING_CLAIMS) return { outcome: "full" };
        const claim = update(row, { method: input.method, tokenHash: input.tokenHash, status: "pending", verifiedAt: null, lastCheckedAt: null, failures: 0, lapsedAt: null, lastResult: null, lastDetail: null });
        return { outcome: "restarted", claim };
      });
    },

    async recordClaimFailure(claimId, input) {
      const checkedAt = iso(input.checkedAt);
      return op(() => {
        const found = checkable(claimId, input.tokenHash);
        if ("done" in found) return found.done;
        const { row } = found;
        const failures = row.claim.failures + 1;
        const lapses = (row.claim.status === "verified" || row.claim.status === "lapsed") && failures >= CLAIM_LAPSE_AFTER;
        const status: ClaimStatus = lapses ? "lapsed" : row.claim.status;
        // The lapse instant is the failure that lapsed it; later failures keep it.
        const lapsedAt = status === "lapsed" ? (row.claim.lapsedAt ?? checkedAt) : null;
        return { outcome: "updated", claim: update(row, { failures, status, lapsedAt, lastCheckedAt: checkedAt, lastResult: input.result, lastDetail: input.detail }) };
      });
    },

    async verifyClaim(claimId, input) {
      const checkedAt = iso(input.checkedAt);
      return op(() => {
        const found = checkable(claimId, input.tokenHash);
        if ("done" in found) return found.done;
        const { row } = found;
        const movedFrom: string[] = [];
        for (const other of claims.values()) {
          if (other === row || other.claim.host !== row.claim.host || (other.claim.status !== "verified" && other.claim.status !== "lapsed")) continue;
          update(other, { status: "superseded", supersededAt: checkedAt });
          other.supersededBy = row.claim.accountId;
          movedFrom.push(other.claim.accountId);
        }
        // The host moved: every publication under another claim ends (also one paused by a pending claim).
        if (published.get(row.claim.host)?.claimId !== row.claim.id) published.delete(row.claim.host);
        const verifiedAt = row.claim.status === "verified" ? row.claim.verifiedAt : checkedAt;
        const claim = update(row, { status: "verified", verifiedAt, lapsedAt: null, lastCheckedAt: checkedAt, failures: 0, lastResult: "verified", lastDetail: null });
        return { outcome: "verified", claim, movedFrom };
      });
    },

    async listClaimsDueForRecheck(rawNow, limit) {
      const now = Date.parse(rawNow);
      // Never checked sorts first, as in the database (nulls first).
      const checked = (c: Claim) => (c.lastCheckedAt === null ? 0 : Date.parse(c.lastCheckedAt));
      const due = (c: Claim) => {
        if (c.status === "verified") return checked(c) < now - CLAIM_RECHECK_AFTER_S * 1000;
        if (c.status !== "lapsed") return false;
        const slow = c.lapsedAt !== null && Date.parse(c.lapsedAt) < now - CLAIM_SLOW_AFTER_S * 1000;
        return checked(c) < now - (slow ? CLAIM_SLOW_RECHECK_AFTER_S : CLAIM_RECHECK_AFTER_S) * 1000;
      };
      const rank = (c: Claim) => (c.status === "verified" ? 0 : 1);
      return op(() =>
        [...claims.values()]
          .map((r) => r.claim)
          .filter(due)
          .sort((x, y) => rank(x) - rank(y) || checked(x) - checked(y))
          .slice(0, Math.max(0, limit))
          .map(copy),
      );
    },

    async deleteClaim(accountId, claimId) {
      return op(() => {
        if (!ownRow(accountId, claimId)) return false;
        claims.delete(claimId);
        // As published_sites.claim_id ... on delete cascade.
        for (const [host, row] of published) if (row.claimId === claimId) published.delete(host);
        return true;
      });
    },

    async publishSite(rawId, input) {
      const accountId = requireAccountId(rawId);
      const { fetchedAt, now } = requirePublishInput(input);
      const { host } = input;
      return op((): PublishSiteResult => {
        const claim = accountClaims(accountId).find((r) => r.claim.host === host)?.claim;
        if (!claim) return { outcome: "no_claim" };
        if (claim.status !== "verified") return { outcome: "not_verified" };
        const mine = ownSite(accountId, host);
        if (mine && Date.parse(mine.fetchedAt) >= Date.parse(fetchedAt)) return { outcome: "not_newer" };
        const row: PublishedRow = {
          host,
          accountId,
          claimId: claim.id,
          snapshot: structuredClone(input.snapshot),
          report: structuredClone(input.report),
          fetchedAt,
          publishedAt: mine?.publishedAt ?? now,
          refreshedAt: now,
          lastRefreshError: null,
        };
        published.set(host, row);
        return { outcome: mine ? "refreshed" : "published", site: ownedSite(row) };
      });
    },

    async recordRefreshError(accountId, host, code) {
      requireRefreshError(code);
      return op(() => {
        const row = ownSite(accountId, host);
        if (!row) return false;
        row.lastRefreshError = code;
        return true;
      });
    },

    async unpublishSite(accountId, host) {
      return op(() => ownSite(accountId, host) !== undefined && published.delete(host));
    },

    async listPublishedSites(accountId) {
      return op(() =>
        [...published.values()]
          .filter((r) => r.accountId === accountId)
          .sort((x, y) => (x.host < y.host ? -1 : 1))
          .map(ownedSite),
      );
    },

    async getPublicSite(host) {
      return op(() => {
        const row = publicRow(host);
        return row && publicSite(row);
      });
    },

    async getPublicReport(host) {
      return op(() => {
        const row = publicRow(host);
        return row && { ...publicSite(row), report: structuredClone(row.report) };
      });
    },

    async getPublicSnapshot(host) {
      return op(() => {
        const row = publicRow(host);
        return row && { ...publicSite(row), snapshot: structuredClone(row.snapshot) };
      });
    },

    async listPublicHosts(limit) {
      return op(() =>
        [...published.values()]
          .filter(isPublic)
          .sort((x, y) => Date.parse(y.refreshedAt) - Date.parse(x.refreshedAt) || (x.host < y.host ? -1 : 1))
          .slice(0, Math.max(0, limit))
          .map((r) => r.host),
      );
    },
  };
}
