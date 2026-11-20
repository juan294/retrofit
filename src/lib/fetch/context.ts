import type { Config } from "../config";
import type { Clock, Store } from "../store/types";
import { systemClock } from "../store/types";
import type { Resolver } from "./guard";
import type { FetchContext, Pace } from "./http";
import { createPacer } from "./pacing";
import { createRobots } from "./robots";

export interface FetchContextOptions {
  readonly config: Config;
  readonly store: Store;
  readonly clock?: Clock;
  readonly lookup?: Resolver;
  /** Minimum interval between requests to one host. 1 s in production; tests may lower it. */
  readonly minIntervalMs?: number;
  /** Latest start after a pacing slot's start (pacing.ts). 250 ms in production; tests with a tiny interval lower it. */
  readonly lateStartToleranceMs?: number;
  /** Pacing waits. Default: a timer. A test with a fake clock passes a sleep that moves that clock. */
  readonly sleep?: (ms: number) => Promise<void>;
}

/** Builds the guarded fetch context: store-backed pacing for every host and robots rules per host. */
export function createFetchContext(o: FetchContextOptions): FetchContext {
  const clock = o.clock ?? systemClock;
  const pacer = createPacer({
    store: o.store,
    clock,
    sleep: o.sleep,
    minIntervalMs: o.minIntervalMs ?? 1000,
    lateStartToleranceMs: o.lateStartToleranceMs,
  });
  // Typed as Pace so the deadline cannot be dropped again by a shorter parameter list.
  const pace: Pace = (host, delay, notAfter) => pacer.pace(host, delay, notAfter);
  const robots = createRobots({ config: o.config, store: o.store, pace, lookup: o.lookup, clock });
  return { config: o.config, store: o.store, robots, pace, lookup: o.lookup };
}
