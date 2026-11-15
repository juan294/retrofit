import { type Env, type FreeConfig, loadFreeConfig } from "@/lib/config";
import { type SupabaseStoreOptions, createSupabaseStore } from "@/lib/store/supabase";
import { type Clock, type Store, systemClock } from "@/lib/store/types";
import { type FreeState, type ResumeResult, describeFreeState, resumeFree } from "./hold";

/**
 * The store and free-path settings that `pnpm ops:resume-free` acts on
 * (tools/ops/resume-free.mjs). The owner names the target store and the
 * deployment's ledger amounts in the environment; nothing falls back to the
 * local defaults, because the remaining credit (and so the balance check) and
 * the bound printed for the owner depend on them. The service role key is
 * passed to the store client only; it is never returned or printed.
 */

/** Every variable the command needs, named in the refusal when one is missing. */
export const RESUME_REQUIRED_ENV = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "FREE_CREDIT_USD",
  "JUDGE_RESERVE_USD",
  "FREE_PRICE_IN_PER_M",
  "FREE_PRICE_OUT_PER_M",
] as const;

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
    inspect: () => describeFreeState(deps),
    resume: (input) => resumeFree(deps, input),
  };
}
