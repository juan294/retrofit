import { type Env, type FreeConfig, loadFreeConfig } from "@/lib/config";
import { type SupabaseStoreOptions, createSupabaseStore } from "@/lib/store/supabase";
import { type Clock, type Store, systemClock } from "@/lib/store/types";
import { type FreeState, type ResumeResult, describeFreeState, resumeFree } from "./hold";

/**
 * The store and free-path settings that `pnpm ops:resume-free` acts on
 * (tools/ops/resume-free.mjs). The owner must name the target store, the
 * credit, the judge reserve, the prices and the service end in the
 * environment (RESUME_REQUIRED_ENV): the remaining credit, the balance check
 * and a public daily budget written on a UTC day rollover depend on them. The
 * other free-path settings (fee, bound and limits) keep their config.ts
 * defaults when unset; `settings` lists every effective value and marks each
 * default, and the command prints it before any change. The service role key
 * is passed to the store client only; it is never returned or printed.
 */

/** Every variable the command needs, named in the refusal when one is missing. */
export const RESUME_REQUIRED_ENV = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "FREE_CREDIT_USD",
  "JUDGE_RESERVE_USD",
  "FREE_PRICE_IN_PER_M",
  "FREE_PRICE_OUT_PER_M",
  "FREE_SERVICE_END",
] as const;

/** Every non-secret free-path setting, by its variable, with its effective value. Keys, codes and tokens are left out. */
const SETTINGS: ReadonlyArray<readonly [string, (c: FreeConfig) => string | number]> = [
  ["FREE_MODEL", (c) => c.model],
  ["FREE_PRICE_IN_PER_M", (c) => c.priceInPerM],
  ["FREE_PRICE_OUT_PER_M", (c) => c.priceOutPerM],
  ["FREE_PER_REQUEST_FEE_USD", (c) => c.perRequestFeeUsd],
  ["FREE_CREDIT_USD", (c) => c.creditUsd],
  ["JUDGE_RESERVE_USD", (c) => c.judgeReserveUsd],
  ["FREE_SERVICE_END", (c) => new Date(c.serviceEndMs).toISOString()],
  ["FREE_MAX_TOKENS", (c) => c.maxTokens],
  ["FREE_MAX_BODY_BYTES", (c) => c.maxBodyBytes],
  ["FREE_FRAMING_TOKENS_PER_MESSAGE", (c) => c.framingTokensPerMessage],
  ["FREE_FRAMING_TOKENS_BASE", (c) => c.framingTokensBase],
  ["FREE_MAX_MESSAGES", (c) => c.maxMessages],
  ["FREE_MAX_TOOLS", (c) => c.maxTools],
  ["FREE_MAX_TOOL_BYTES", (c) => c.maxToolBytes],
  ["FREE_INFLIGHT_PER_SESSION", (c) => c.inflightPerSession],
  ["FREE_INFLIGHT_GLOBAL", (c) => c.inflightGlobal],
  ["FREE_CALLS_PER_SESSION", (c) => c.callsPerSession],
  ["FREE_SESSIONS_PER_CLIENT_HOUR", (c) => c.sessionsPerClientHour],
  ["JUDGE_CALLS_PER_SESSION_DAY", (c) => c.judgeCallsPerSessionDay],
  ["JUDGE_SESSIONS_PER_CLIENT_DAY", (c) => c.judgeSessionsPerClientDay],
  ["FREE_UPSTREAM_TIMEOUT_MS", (c) => c.upstreamTimeoutMs],
  ["CREDIT_ALERT_THRESHOLDS", (c) => c.alertThresholds.join(",")],
];

export interface EffectiveSetting {
  readonly name: string;
  readonly value: string;
  /** "set" when the environment names it, "default" when config.ts supplied it. */
  readonly source: "set" | "default";
}

export class ResumeTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResumeTargetError";
  }
}

export interface ResumeTarget {
  /** Origin of the target store, for the owner to confirm. */
  readonly origin: string;
  readonly config: FreeConfig;
  readonly settings: readonly EffectiveSetting[];
  inspect(): Promise<FreeState>;
  resume(input: { reconciledBalanceUsd: number; note: string }): Promise<ResumeResult>;
}

export function resumeTargetFromEnv(
  env: Env,
  options: { clock?: Clock; createStore?: (options: SupabaseStoreOptions) => Store } = {},
): ResumeTarget {
  const missing = RESUME_REQUIRED_ENV.filter((name) => !env[name]?.trim());
  if (missing.length) {
    throw new ResumeTargetError(`Set ${missing.join(", ")} to the target deployment's values. No store or ledger amount is assumed.`);
  }
  let origin: string;
  try {
    const url = new URL(env.SUPABASE_URL!.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("protocol");
    origin = url.origin;
  } catch {
    throw new ResumeTargetError("SUPABASE_URL must be an http or https URL.");
  }
  let config: FreeConfig;
  try {
    config = loadFreeConfig(env, false);
  } catch (error) {
    throw new ResumeTargetError(error instanceof Error ? error.message : String(error));
  }
  const store = (options.createStore ?? createSupabaseStore)({ url: origin, serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY!.trim() });
  const deps = { store, config, clock: options.clock ?? systemClock };
  return {
    origin,
    config,
    settings: SETTINGS.map(([name, read]) => ({ name, value: String(read(config)), source: env[name]?.trim() ? "set" : "default" })),
    inspect: () => describeFreeState(deps),
    resume: (input) => resumeFree(deps, input),
  };
}
