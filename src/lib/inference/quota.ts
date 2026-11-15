import type { FreeConfig } from "@/lib/config";
import type { Clock, Store } from "@/lib/store/types";
import { guarded } from "./errors";
import { type Pool, utcDay } from "./ledger";

/**
 * Free-path quotas (phase 6, "Ledger and quotas"): calls per session, new
 * sessions per client, and in-flight slots. Counters use the store's atomic
 * incrementWindow; in-flight slots are 60 s leases, so a crashed request frees
 * its slot when the lease ends.
 */

export type CapReason =
  | "session_calls"
  | "judge_session_calls"
  | "client_sessions"
  | "judge_client_sessions"
  | "inflight_session"
  | "inflight_global"
  | "public_pool"
  | "judge_pool"
  | "ledger";

const REASON_PHRASE: Record<CapReason, string> = {
  session_calls: "this session",
  judge_session_calls: "this judge session",
  client_sessions: "new sessions from your network this hour",
  judge_client_sessions: "judge sessions from your network today",
  inflight_session: "this session until your other requests finish",
  inflight_global: "the moment because many visitors are using it",
  public_pool: "today",
  judge_pool: "the judge reserve",
  ledger: "the rest of the free period",
};

/** Visitor text for a cap (parent plan, stuck state "Free cap reached"). */
export function capMessage(reason: CapReason): string {
  return `Retrofit's free AI is used up for ${REASON_PHRASE[reason]}. Paste your own key in AI settings to continue.`;
}

export type QuotaRefusal = { ok: false; status: 429; reason: CapReason; message: string };
export type QuotaResult = { ok: true } | QuotaRefusal;
export type SlotResult = { ok: true; release: () => Promise<void> } | QuotaRefusal;

export const refusal = (reason: CapReason): QuotaRefusal => ({ ok: false, status: 429, reason, message: capMessage(reason) });

export interface QuotaDeps {
  readonly store: Store;
  readonly config: FreeConfig;
  readonly clock: Clock;
}

export const INFLIGHT_LEASE_S = 60;
/** Session call counters outlive any renewed session in the free period. */
const SESSION_COUNTER_WINDOW_S = 90 * 86_400;
const HOUR_S = 3600;
const DAY_S = 86_400;

const id = (s: string) => encodeURIComponent(s);
const keys = {
  calls: (sid: string) => `inference:quota:calls:${id(sid)}`,
  clientSessions: (client: string) => `inference:quota:sessions:${id(client)}`,
  judgeSessions: (client: string, day: string) => `inference:quota:judge-sessions:${id(client)}:${day}`,
  sessionSlot: (sid: string, i: number) => `inference:quota:inflight:session:${id(sid)}:${i}`,
  globalSlot: (i: number) => `inference:quota:inflight:global:${i}`,
};

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

  return {
    /** Counts one model call for the session; call N+1 of the pool's cap is refused. */
    async admitCall(input: { sid: string; pool: Pool }): Promise<QuotaResult> {
      const cap = input.pool === "judge" ? free.judgeCallsPerSession : free.callsPerSession;
      const n = await count("calls", keys.calls(input.sid), SESSION_COUNTER_WINDOW_S);
      return n > cap ? refusal(input.pool === "judge" ? "judge_session_calls" : "session_calls") : { ok: true };
    },

    /** Calls counted for the session so far, without counting one (an increment of 0 reads the window). */
    callsUsed(sid: string): Promise<number> {
      return count("calls", keys.calls(sid), SESSION_COUNTER_WINDOW_S, 0);
    },

    /** Counts one new session for the client in a one-hour window. Renewals must not call it. */
    async admitSession(input: { client: string }): Promise<QuotaResult> {
      const n = await count("sessions", keys.clientSessions(input.client), HOUR_S);
      return n > free.sessionsPerClientHour ? refusal("client_sessions") : { ok: true };
    },

    /** Counts one judge upgrade for the client in the current UTC day. */
    async admitJudgeSession(input: { client: string }): Promise<QuotaResult> {
      const n = await count("judge sessions", keys.judgeSessions(input.client, utcDay(clock())), DAY_S);
      return n > free.judgeSessionsPerClientDay ? refusal("judge_client_sessions") : { ok: true };
    },

    /** Takes one session slot and one global slot (60 s leases). `release` frees both and is safe to call twice. */
    acquireInflight(sid: string): Promise<SlotResult> {
      return guarded("in-flight", async () => {
        const session = await takeSlot((i) => keys.sessionSlot(sid, i), free.inflightPerSession);
        if (!session) return refusal("inflight_session");
        const global = await takeSlot(keys.globalSlot, free.inflightGlobal);
        if (!global) {
          await store.releaseLease(session.key, session.token);
          return refusal("inflight_global");
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
