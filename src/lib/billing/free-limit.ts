import { createHmac } from "node:crypto";
import ipaddr from "ipaddr.js";
import { clientIpFrom, ttlUntil } from "@/lib/fetch/limits";
import { realSleep } from "@/lib/fetch/timers";
import type { ServerDeps } from "@/lib/server/runtime";
import { logBillingFailure } from "./sync";

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

/** The network of an address: IPv4 as it is, IPv6 as its /64 (one home or one server has a whole /64). Anything else as it is. */
export function networkOf(ip: string): string {
  const bare = ip.replace(/%.*$/, "");
  if (!ipaddr.isValid(bare)) return ip;
  const address = ipaddr.process(bare);
  return address instanceof ipaddr.IPv6 ? `${address.parts.slice(0, 4).map((p) => p.toString(16)).join(":")}::/64` : address.toString();
}

/** Call only from BILLING_START on. */
export function freeCountOf(request: Request, visitorHash: string, deps: Pick<Deps, "config" | "clock">): FreeCount {
  const windowMs = FREE_WINDOW_S * 1000;
  const { billingStart, sessionSecret } = deps.config;
  const bucket = Math.floor((deps.clock() - billingStart) / windowMs);
  const network = createHmac("sha256", sessionSecret).update(`retrofit-free-network-v1:${bucket}\n${networkOf(clientIpFrom(request))}`).digest("hex");
  return { keys: [`free-analyses:visitor:${visitorHash}:${bucket}`, `free-analyses:network:${network}:${bucket}`], endsAt: billingStart + (bucket + 1) * windowMs };
}

export interface FreeReservation {
  /** Gives the place back: the analysis did not start. */
  release(): Promise<void>;
}

const logFailure = (e: unknown) => logBillingFailure("The free-analysis count", e);

const ATTEMPTS = 3;
const RETRY_WAIT_MS = 25;

/**
 * One place in the visitor's count and then in the network's, or null when either is full. The visitor's
 * comes first, so a visitor whose own count is full never takes a place of the network. A full count is
 * looked at again after a moment: a place held by a start that failed meanwhile is found, and one that a
 * refused start took for an instant refuses nobody. A failing count never refuses a visit: it is logged
 * and the analysis goes on.
 */
export async function reserveFreeAnalysis(deps: Deps, count: FreeCount): Promise<FreeReservation | null> {
  const ttl = ttlUntil(count.endsAt, deps.clock());
  const add = (key: string, by: number) => deps.store.incrementWindow(key, ttl, by);
  const taken: string[] = [];
  const release = async () => {
    for (const r of await Promise.allSettled(taken.splice(0).map((key) => add(key, -1)))) if (r.status === "rejected") logFailure(r.reason);
  };

  async function take(key: string): Promise<boolean> {
    for (let attempt = 1; ; attempt++) {
      if ((await add(key, 1)) <= FREE_ANALYSES) {
        taken.push(key);
        return true;
      }
      await add(key, -1);
      if (attempt === ATTEMPTS) return false;
      await realSleep(RETRY_WAIT_MS);
      if ((await add(key, 0)) >= FREE_ANALYSES) return false;
    }
  }

  try {
    for (const key of count.keys) {
      if (await take(key)) continue;
      await release();
      return null;
    }
  } catch (e) {
    logFailure(e);
  }
  return { release };
}
