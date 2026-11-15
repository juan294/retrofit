import type { Config } from "../config";
import { routerOrigins } from "../keys/providers";
import type { PhaseOrigins } from "./headers";

/**
 * Origins the page may connect to beyond its own: the provider routers in the
 * key panel (Phase 4) and, in fixtures mode only, the loopback test peers.
 */
export function connectOrigins(_config: Config, fixtureOrigins: readonly string[] = []): PhaseOrigins {
  return { origins: routerOrigins(), fixtureOrigins };
}
