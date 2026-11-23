import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * The server's Supabase client with the service role key, shared by the Store
 * and AccountData adapters. Server only: never import it from client code.
 *
 * postgrest-js retries GET, HEAD and OPTIONS up to three times with backoff
 * (1 s, 2 s, 4 s); `retry: false` makes reads fail closed within one timeout.
 * The Store's rpc calls are POST, which postgrest-js never retries, so this
 * setting changes nothing for them.
 */

export interface ServiceClientOptions {
  readonly url: string;
  /** Server only. Never sent to a browser, logged or written to evidence. */
  readonly serviceRoleKey: string;
  /** Per-request timeout. Default 10 s. */
  readonly timeoutMs?: number;
}

export type ServiceClient = SupabaseClient;

/** Either the options to build a client, or a client to share (the runtime builds one per process). */
export type ServiceClientSource = ServiceClientOptions | ServiceClient;

function withTimeout(base: typeof fetch, ms: number): typeof fetch {
  return (input, init) => {
    const timeout = AbortSignal.timeout(ms);
    const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    return base(input, { ...init, signal });
  };
}

export function createServiceClient(options: ServiceClientOptions): ServiceClient {
  return createClient(options.url, options.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: withTimeout(fetch, options.timeoutMs ?? 10_000) },
    db: { retry: false },
  });
}

export function serviceClient(source: ServiceClientSource): ServiceClient {
  return "serviceRoleKey" in source ? createServiceClient(source) : source;
}

/** A failed service call. Callers fail closed; there is no fallback. */
export class ServiceUnavailable extends Error {
  constructor(
    public readonly operation: string,
    /** PostgREST or Postgres error code, or "request_failed" for a transport failure. */
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ServiceUnavailable";
  }
}

export interface CallLabel {
  /** "store" or "accounts": the log line's subject. */
  readonly service: string;
  readonly operation: string;
  /** A safe detail for the log (for example a key prefix). Never a value, an email, a token or a key. */
  readonly detail?: string;
}

interface Result<T> {
  data: T | null;
  error: { code?: string } | null;
}

/**
 * Runs one PostgREST call (built inside, so a builder that throws counts as a failure too). On failure it logs `[TABLE_FALLBACK]` at ERROR with
 * the label and the error code only, and throws `unavailable(code)`.
 */
export async function serviceCall<T>(label: CallLabel, request: () => PromiseLike<Result<T>>, unavailable: (code: string) => ServiceUnavailable): Promise<T | null> {
  let code: string;
  try {
    const { data, error } = await request();
    if (!error) return data;
    code = error.code || "request_failed";
  } catch {
    code = "request_failed";
  }
  const detail = label.detail ? `${label.detail}, ` : "";
  console.error(`[TABLE_FALLBACK] ${label.service} ${label.operation} failed (${detail}${code})`);
  throw unavailable(code);
}
