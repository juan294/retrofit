import { createHmac } from "node:crypto";
import { clientIpFrom, ttlUntil } from "@/lib/fetch/limits";
import type { ServerDeps } from "@/lib/server/runtime";

/**
 * The free analyses of visitors without an account, from BILLING_START on: FREE_ANALYSES per visitor
 * cookie and per network, in fixed windows of FREE_WINDOW_S that start at BILLING_START. A start takes
 * its place in both counts before any work (an atomic increment, so parallel starts never pass the
 * limit together) and gives it back when it is refused or fails. A signed-in account is not counted.
 *
 * The daily client id of fetch/limits.ts cannot hold a count longer than a day, so the network is a
 * keyed hash of the IP address that changes with each window. The address itself is never stored.
 */

export const FREE_ANALYSES = 5;
export const FREE_WINDOW_S = 30 * 24 * 3600;

type Deps = Pick<ServerDeps, "config" | "clock" | "store">;

/** The Store keys of one visitor's and one network's count, and when their window ends. */
export interface FreeCount {
  readonly keys: readonly string[];
  readonly endsAt: number;
}

/** Call only from BILLING_START on. */
export function freeCountOf(request: Request, visitorHash: string, deps: Pick<Deps, "config" | "clock">): FreeCount {
  const windowMs = FREE_WINDOW_S * 1000;
  const { billingStart, sessionSecret } = deps.config;
  const bucket = Math.floor((deps.clock() - billingStart) / windowMs);
  const network = createHmac("sha256", sessionSecret).update(`retrofit-free-network-v1:${bucket}\n${clientIpFrom(request)}`).digest("hex");
  return { keys: [`free-analyses:visitor:${visitorHash}:${bucket}`, `free-analyses:network:${network}:${bucket}`], endsAt: billingStart + (bucket + 1) * windowMs };
}

export interface FreeReservation {
  /** Gives the place back: the analysis did not start. */
  release(): Promise<void>;
}

const logFailure = (e: unknown) => console.error("The free-analysis count failed:", e instanceof Error ? e.name : "unknown error");

/** One place in both counts, or null when either is full. A failing count never refuses a visit: it is logged and the analysis goes on. */
export async function reserveFreeAnalysis(deps: Deps, count: FreeCount): Promise<FreeReservation | null> {
  const ttl = ttlUntil(count.endsAt, deps.clock());
  const results = await Promise.allSettled(count.keys.map((key) => deps.store.incrementWindow(key, ttl)));
  const taken = count.keys.filter((_, i) => results[i]?.status === "fulfilled");
  const release = async () => {
    for (const r of await Promise.allSettled(taken.map((key) => deps.store.incrementWindow(key, ttl, -1)))) if (r.status === "rejected") logFailure(r.reason);
  };
  for (const r of results) if (r.status === "rejected") logFailure(r.reason);
  if (results.some((r) => r.status === "fulfilled" && r.value > FREE_ANALYSES)) {
    await release();
    return null;
  }
  return { release };
}
