import { randomUUID } from "node:crypto";
import { systemClock, type Clock } from "@/lib/store/types";
import type { AgentSnapshot } from "@/lib/snapshot/types";
import { newToken, sha256Hex, SHA256_HEX_PATTERN } from "@/lib/security/tokens";
import {
  CLAIM_LAPSE_AFTER,
  CLAIM_RECHECK_AFTER_S,
  CLAIM_SLOW_AFTER_S,
  CLAIM_SLOW_RECHECK_AFTER_S,
  isUuid,
  MAX_API_KEYS,
  MAX_PENDING_CLAIMS,
  MAX_SAVED_REPORTS,
  normalizeEmail,
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
  requireTime,
  scoreOf,
  type AccountData,
  type ApiKey,
  type ApplyBillingResult,
  type BillingRecord,
  type Claim,
  type ClaimStatus,
  type LinkCustomerResult,
  type NotifySignup,
  type ObservedBilling,
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
  /** The latest recheck attempt that recorded no result (ms). Never returned. */
  attemptedAt?: number;
  /** The latest check that counts, when a visitor's failed check is the latest one (the database's last_checked_at). */
  countedAt?: string | null;
  /** The account that took the host over; null after that account's data is deleted. Never returned. */
  supersededBy: string | null;
  /** Insertion order, for oldest-first lists. */
  readonly seq: number;
}

interface PublishedRow {
  readonly host: string;
  readonly accountId: string;
  readonly claimId: string;
  readonly snapshot: AgentSnapshot;
  readonly report: Record<string, unknown>;
  readonly fetchedAt: string;
  readonly publishedAt: string;
  readonly refreshedAt: string;
  lastRefreshError: RefreshError | null;
}

interface ApiKeyRow {
  readonly key: ApiKey;
  readonly accountId: string;
  readonly keyHash: string;
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
  /** Keyed by account id. */
  readonly billing: Map<string, BillingRecord>;
  /** Recorded Stripe event ids, oldest first, with when they were received. */
  readonly stripeEvents: Map<string, { readonly type: string; readonly receivedAt: number }>;
  /** SHA-256 of the customer ids of deleted accounts. */
  readonly deletedCustomers: Set<string>;
  /** Keyed by key id. */
  readonly apiKeys: Map<string, ApiKeyRow>;
}

export function createAccountMemoryBacking(): AccountMemoryBacking {
  return { notify: new Map(), profiles: new Map(), savedReports: new Map(), claims: new Map(), published: new Map(), billing: new Map(), stripeEvents: new Map(), deletedCustomers: new Set(), apiKeys: new Map() };
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
  const { notify, profiles, savedReports, claims, published, billing, stripeEvents, deletedCustomers, apiKeys } = options.backing ?? createAccountMemoryBacking();
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

  const byCustomer = (customerId: string): BillingRecord | undefined => [...billing.values()].find((r) => r.customerId === customerId);
  /** applyBillingState on the stored row, inside one operation. */
  const applyState = (customerId: string, { observedAt, ...state }: ObservedBilling): ApplyBillingResult => {
    const row = byCustomer(customerId);
    if (!row) return { outcome: "unknown" };
    if (row.stateAt !== null && Date.parse(row.stateAt) > Date.parse(observedAt)) return { outcome: "stale", billing: { ...row } };
    const stillUnpaid = state.status === "past_due" && row.status === "past_due" && row.subscriptionId === state.subscriptionId;
    const unpaid = [stillUnpaid ? row.unpaidSince : null, state.unpaidSince].filter((t) => t !== null).sort((x, y) => Date.parse(x) - Date.parse(y));
    const next: BillingRecord = { ...row, ...state, unpaidSince: state.status === "past_due" ? (unpaid[0] ?? null) : null, stateAt: observedAt };
    billing.set(row.accountId, next);
    return { outcome: "applied", billing: { ...next } };
  };

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
        const customer = billing.get(accountId)?.customerId;
        if (customer) deletedCustomers.add(sha256Hex(customer));
        billing.delete(accountId);
        for (const [id, row] of apiKeys) if (row.accountId === accountId) apiKeys.delete(id);
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
        const shown = { lastCheckedAt: checkedAt, lastResult: input.result, lastDetail: input.detail };
        if (input.byVisitor && row.claim.status === "verified") {
          row.countedAt ??= row.claim.lastCheckedAt;
          return { outcome: "updated", claim: update(row, shown) };
        }
        row.countedAt = null;
        const failures = row.claim.failures + 1;
        const lapses = (row.claim.status === "verified" || row.claim.status === "lapsed") && failures >= CLAIM_LAPSE_AFTER;
        const status: ClaimStatus = lapses ? "lapsed" : row.claim.status;
        // The lapse instant is the failure that lapsed it; later failures keep it.
        const lapsedAt = status === "lapsed" ? (row.claim.lapsedAt ?? checkedAt) : null;
        return { outcome: "updated", claim: update(row, { failures, status, lapsedAt, ...shown }) };
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
        row.countedAt = null;
        const verifiedAt = row.claim.status === "verified" ? row.claim.verifiedAt : checkedAt;
        const claim = update(row, { status: "verified", verifiedAt, lapsedAt: null, lastCheckedAt: checkedAt, failures: 0, lastResult: "verified", lastDetail: null });
        return { outcome: "verified", claim, movedFrom };
      });
    },

    async listClaimsDueForRecheck(rawNow, limit) {
      const now = Date.parse(rawNow);
      // Never checked sorts first, as in the database (nulls first).
      const checked = (r: ClaimRow) => Date.parse(r.countedAt ?? r.claim.lastCheckedAt ?? iso(0));
      const due = (r: ClaimRow) => {
        const c = r.claim;
        if (c.status === "verified") return checked(r) < now - CLAIM_RECHECK_AFTER_S * 1000;
        if (c.status !== "lapsed") return false;
        const slow = c.lapsedAt !== null && Date.parse(c.lapsedAt) < now - CLAIM_SLOW_AFTER_S * 1000;
        return checked(r) < now - (slow ? CLAIM_SLOW_RECHECK_AFTER_S : CLAIM_RECHECK_AFTER_S) * 1000;
      };
      const rank = (c: Claim) => (c.status === "verified" ? 0 : 1);
      const tried = (r: ClaimRow) => Math.max(checked(r), r.attemptedAt ?? 0);
      return op(() =>
        [...claims.values()]
          .filter(due)
          .sort((x, y) => rank(x.claim) - rank(y.claim) || tried(x) - tried(y))
          .slice(0, Math.max(0, limit))
          .map((r) => copy(r.claim)),
      );
    },

    async recordClaimAttempt(claimId, rawAt) {
      const at = Date.parse(iso(rawAt));
      return op(() => {
        const row = claims.get(claimId);
        if (row) row.attemptedAt = at;
      });
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
        if (mine && Date.parse(mine.fetchedAt) >= Date.parse(fetchedAt)) return { outcome: "not_newer", site: ownedSite(mine) };
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
        if (!row) return null;
        row.lastRefreshError = code;
        return ownedSite(row);
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

    async getBilling(accountId) {
      return op(() => {
        const row = billing.get(accountId);
        return row ? { ...row } : null;
      });
    },

    async getBillingByCustomer(customerId) {
      return op(() => {
        const row = byCustomer(customerId);
        return row ? { ...row } : null;
      });
    },

    async linkBillingCustomer(rawId, rawCustomer) {
      const accountId = requireAccountId(rawId);
      const customerId = requireCustomerId(rawCustomer);
      return op((): LinkCustomerResult => {
        if (!profiles.has(accountId)) return { outcome: "no_account" };
        const existing = billing.get(accountId);
        if (existing) return { outcome: "existing", billing: { ...existing } };
        if (byCustomer(customerId)) return { outcome: "taken" };
        const row: BillingRecord = { accountId, customerId, plan: "free", status: "none", currentPeriodEnd: null, cancelAtPeriodEnd: false, subscriptionId: null, unpaidSince: null, stateAt: null };
        billing.set(accountId, row);
        deletedCustomers.delete(sha256Hex(customerId));
        return { outcome: "linked", billing: { ...row } };
      });
    },

    async applyBillingState(rawCustomer, rawState) {
      const customerId = requireCustomerId(rawCustomer);
      const state = requireBillingState(rawState);
      return op(() => applyState(customerId, state));
    },

    async applyBillingEvent(event, rawCustomer, rawState) {
      requireBillingEvent(event);
      const customerId = requireCustomerId(rawCustomer);
      const state = requireBillingState(rawState);
      return op((now) => {
        if (!byCustomer(customerId)) return { outcome: "unknown" };
        if (stripeEvents.has(event.id)) return { outcome: "duplicate" };
        const applied = applyState(customerId, state);
        if (applied.outcome === "applied") stripeEvents.set(event.id, { type: event.type, receivedAt: now });
        return applied;
      });
    },

    async checkReady() {
      return op(() => undefined);
    },

    /** The memory adapter has no sign-in users. */
    async purgeUsersWithoutAccount(rawBefore) {
      requireTime("before", rawBefore);
      return op(() => 0);
    },

    async pruneStripeEvents(rawBefore, limit) {
      const before = Date.parse(requireTime("before", rawBefore));
      return op(() => {
        const old = [...stripeEvents].filter(([, e]) => e.receivedAt < before).slice(0, Math.max(0, limit));
        for (const [id] of old) stripeEvents.delete(id);
        return old.length;
      });
    },

    async isDeletedCustomer(customerId) {
      return op(() => deletedCustomers.has(sha256Hex(customerId)));
    },

    async createApiKey(rawId, input) {
      const accountId = requireAccountId(rawId);
      requireApiKey(input);
      return op((now) => {
        if ([...apiKeys.values()].filter((r) => r.accountId === accountId).length >= MAX_API_KEYS) return { outcome: "full" };
        const key: ApiKey = { id: randomUUID(), hint: input.hint, createdAt: iso(now) };
        apiKeys.set(key.id, { key, accountId, keyHash: input.keyHash });
        return { outcome: "created", key: { ...key } };
      });
    },

    async listApiKeys(accountId) {
      return op(() => [...apiKeys.values()].filter((r) => r.accountId === accountId).map((r) => ({ ...r.key })));
    },

    async revokeApiKey(accountId, keyId) {
      return op(() => {
        if (apiKeys.get(keyId)?.accountId !== accountId) return false;
        return apiKeys.delete(keyId);
      });
    },

    async findApiKeyAccount(keyHash) {
      return op(() => [...apiKeys.values()].find((r) => r.keyHash === keyHash)?.accountId ?? null);
    },
  };
}
