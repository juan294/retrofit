import type { Config } from "../config";
import type { Clock, Store } from "../store/types";
import { systemClock } from "../store/types";
import type { Resolver } from "./guard";
import type { FetchContext } from "./http";
import { createPacer } from "./pacing";
import { createRobots } from "./robots";

export interface FetchContextOptions {
  readonly config: Config;
  readonly store: Store;
  readonly clock?: Clock;
  readonly lookup?: Resolver;
  /** Minimum interval between requests to one host. 1 s in production; tests may lower it. */
  readonly minIntervalMs?: number;
}

/** Builds the guarded fetch context: store-backed pacing for every host and robots rules per host. */
export function createFetchContext(o: FetchContextOptions): FetchContext {
  const clock = o.clock ?? systemClock;
  const pacer = createPacer({ store: o.store, clock, minIntervalMs: o.minIntervalMs ?? 1000 });
  const pace = (host: string, delay?: number) => pacer.pace(host, delay);
  const robots = createRobots({ config: o.config, store: o.store, pace, lookup: o.lookup, clock });
  return { config: o.config, store: o.store, robots, pace, lookup: o.lookup };
}
