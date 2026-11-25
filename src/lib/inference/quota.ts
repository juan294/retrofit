import { formatDate, hhmmUtc } from "@/lib/analysis/texts";
import type { FreeConfig } from "@/lib/config";
import { nextUtcMidnight, ttlUntil, utcDay } from "@/lib/fetch/limits";
import type { Clock, Store } from "@/lib/store/types";
import { guarded } from "./errors";
import type { Pool } from "./ledger";

/**
 * Free-path quotas (phase 6, "Ledger and quotas"): calls per public session, calls per judge
 * session and UTC day, calls of a network's judge sessions per UTC day, and in-flight slots. New-session caps live in session.ts. Counters use the store's atomic
 * incrementWindow; in-flight slots are 60 s leases, so a crashed request frees
 * its slot when the lease ends.
 */

export type CapReason =
  | "session_calls"
  | "judge_session_calls"
  | "judge_network_calls"
  | "inflight_session"
  | "inflight_global"
  | "public_pool"
  | "judge_pool"
  | "ledger";

/** The caps of money, and of public use. The judge call caps have their own text (judgeCalls). */
type PhraseReason = Exclude<CapReason, "judge_session_calls" | "judge_network_calls">;

const REASON_PHRASE: Record<PhraseReason, string> = {
  session_calls: "this session",
  inflight_session: "this session until your other requests finish",
  inflight_global: "the moment because many visitors are using it",
  public_pool: "today",
  judge_pool: "the judge reserve",
  ledger: "the rest of the free period",
};

/** A judge waits for these; no judge text asks for a paid key while the judge reserve has money. */
const JUDGE_WAIT: Partial<Record<PhraseReason, string>> = {
  inflight_session: "Judge access is busy with your other requests. Try again when they finish.",
  inflight_global: "Judge access is busy because many visitors are using it. Try again in a minute.",
};

/** Visitor text for a cap (parent plan, stuck state "Free cap reached"). */
export function capMessage(reason: PhraseReason, pool: Pool = "public"): string {
  return (pool === "judge" && JUDGE_WAIT[reason]) || `Retrofit's free AI is used up for ${REASON_PHRASE[reason]}. Use your own AI key to continue.`;
}

/** A judge's calls of the UTC day are used up: its session's, or those of all judge sessions of its network. */
function judgeCalls(reason: "judge_session_calls" | "judge_network_calls", limit: number, now: number): QuotaRefusal {
  const retryAt = nextUtcMidnight(now);
  const again = `works again at ${hhmmUtc(new Date(retryAt))} UTC on ${formatDate(new Date(retryAt))}.`;
  const message = reason === "judge_session_calls" ? `Judge access in this browser made its ${limit} AI calls for today. It ${again}` : `Judges on this network made their ${limit} AI calls for today. Judge access ${again}`;
  return { ok: false, status: 429, reason, message, retryAt };
}

/** `retryAt` (ms) when a time ends the cap. */
export type QuotaRefusal = { ok: false; status: 429; reason: CapReason; message: string; retryAt?: number };
export type QuotaResult = { ok: true } | QuotaRefusal;
export type SlotResult = { ok: true; release: () => Promise<void> } | QuotaRefusal;

export const refusal = (reason: PhraseReason, pool: Pool): QuotaRefusal => ({ ok: false, status: 429, reason, message: capMessage(reason, pool) });

export interface QuotaDeps {
  readonly store: Store;
  readonly config: FreeConfig;
  readonly clock: Clock;
}

export const INFLIGHT_LEASE_S = 60;
/** Session call counters outlive any renewed session in the free period. */
const SESSION_COUNTER_WINDOW_S = 90 * 86_400;

const id = (s: string) => encodeURIComponent(s);
const keys = {
  calls: (sid: string) => `inference:quota:calls:${id(sid)}`,
  judgeCalls: (sid: string, day: string) => `inference:quota:judge-calls:${id(sid)}:${day}`,
  judgeNetwork: (network: string, day: string) => `inference:quota:judge-network-calls:${id(network)}:${day}`,
  sessionSlot: (sid: string, i: number) => `inference:quota:inflight:session:${id(sid)}:${i}`,
  globalSlot: (i: number) => `inference:quota:inflight:global:${i}`,
};

/** Model calls the pool's session may make: in all (public) or in a UTC day (judge). */
export const callCap = (pool: Pool, free: FreeConfig): number => (pool === "judge" ? free.judgeCallsPerSessionDay : free.callsPerSession);

export function createQuota(deps: QuotaDeps) {
  const { store, config: free, clock } = deps;

  const count = (what: string, key: string, windowS: number, by = 1) => guarded(what, () => store.incrementWindow(key, windowS, by));

  /** Takes the first free lease among `n` slot keys. */
  async function takeSlot(keyFor: (i: number) => string, n: number): Promise<{ key: string; token: string } | null> {
    for (let i = 0; i < n; i++) {
      const key = keyFor(i);
      const token = await store.acquireLease(key, INFLIGHT_LEASE_S);
      if (token) return { key, token };
    }
    return null;
  }

  /** The session's call counter: for the whole public session, per UTC day for a judge session (which lasts weeks). */
  function countCalls({ sid, pool }: { sid: string; pool: Pool }, by: number, now: number): Promise<number> {
    if (pool === "public") return count("calls", keys.calls(sid), SESSION_COUNTER_WINDOW_S, by);
    return count("calls", keys.judgeCalls(sid, utcDay(now)), ttlUntil(nextUtcMidnight(now), now), by);
  }

  return {
    /**
     * Counts one model call for the session; call N+1 of the pool's cap is refused. A judge's call also counts for its
     * network in the UTC day: the judge code is shared and a judge session lasts weeks, so sessions add up.
     */
    async admitCall(input: { sid: string; pool: Pool; network: string }): Promise<QuotaResult> {
      const now = clock();
      const n = await countCalls(input, 1, now);
      const admitted = n <= callCap(input.pool, free);
      if (input.pool === "public") return admitted ? { ok: true } : refusal("session_calls", "public");
      if (!admitted) return judgeCalls("judge_session_calls", free.judgeCallsPerSessionDay, now);
      const ofNetwork = await count("calls", keys.judgeNetwork(input.network, utcDay(now)), ttlUntil(nextUtcMidnight(now), now));
      return ofNetwork <= free.judgeCallsPerClientDay ? { ok: true } : judgeCalls("judge_network_calls", free.judgeCallsPerClientDay, now);
    },

    /** Calls in the session's current cap so far, without counting one (an increment of 0 reads the window). */
    callsUsed(input: { sid: string; pool: Pool }): Promise<number> {
      return countCalls(input, 0, clock());
    },

    /** Takes one session slot and one global slot (60 s leases). `release` frees both and is safe to call twice. */
    acquireInflight(sid: string, pool: Pool = "public"): Promise<SlotResult> {
      return guarded("in-flight", async () => {
        const session = await takeSlot((i) => keys.sessionSlot(sid, i), free.inflightPerSession);
        if (!session) return refusal("inflight_session", pool);
        const global = await takeSlot(keys.globalSlot, free.inflightGlobal);
        if (!global) {
          await store.releaseLease(session.key, session.token);
          return refusal("inflight_global", pool);
        }
        return {
          ok: true as const,
          release: () =>
            guarded("in-flight", async () => {
              await store.releaseLease(global.key, global.token);
              await store.releaseLease(session.key, session.token);
            }),
        };
      });
    },
  };
}

export type Quota = ReturnType<typeof createQuota>;
