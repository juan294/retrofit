import { systemClock, type Clock } from "@/lib/store/types";
import { hashToken, newToken, normalizeEmail, requireEmail, TOKEN_HASH_PATTERN, type AccountData, type NotifySignup } from "./data";

interface NotifyRow {
  readonly email: string;
  readonly marketingConsent: boolean;
  readonly unsubscribeTokenHash: string;
  readonly createdAt: number;
  unsubscribedAt: number | null;
}

/** Shared state. Two adapters over one backing model two server instances. */
export interface AccountMemoryBacking {
  /** Keyed by the normalized email. */
  readonly notify: Map<string, NotifyRow>;
}

export function createAccountMemoryBacking(): AccountMemoryBacking {
  return { notify: new Map() };
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
  const { notify } = options.backing ?? createAccountMemoryBacking();

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
        notify.set(email, { email, marketingConsent: consent === true, unsubscribeTokenHash: hashToken(token), createdAt: now, unsubscribedAt: null });
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
        if (!TOKEN_HASH_PATTERN.test(tokenHash)) return "unknown";
        for (const row of notify.values()) {
          if (row.unsubscribeTokenHash !== tokenHash) continue;
          if (row.unsubscribedAt !== null) return "already";
          row.unsubscribedAt = now;
          return "unsubscribed";
        }
        return "unknown";
      });
    },
  };
}
