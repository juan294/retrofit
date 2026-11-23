import { randomUUID } from "node:crypto";
import { systemClock, type Clock } from "@/lib/store/types";
import { newToken, sha256Hex, SHA256_HEX_PATTERN } from "@/lib/security/tokens";
import {
  isUuid,
  MAX_SAVED_REPORTS,
  normalizeEmail,
  requireAccountId,
  requireEmail,
  requireSaveInput,
  scoreOf,
  type AccountData,
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

/** Shared state. Two adapters over one backing model two server instances. */
export interface AccountMemoryBacking {
  /** Keyed by the normalized email. */
  readonly notify: Map<string, NotifyRow>;
  /** Profile creation times, keyed by account id. */
  readonly profiles: Map<string, number>;
  /** Keyed by report id. */
  readonly savedReports: Map<string, SavedReportRow>;
}

export function createAccountMemoryBacking(): AccountMemoryBacking {
  return { notify: new Map(), profiles: new Map(), savedReports: new Map() };
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
  const { notify, profiles, savedReports } = options.backing ?? createAccountMemoryBacking();

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
      });
    },
  };
}
