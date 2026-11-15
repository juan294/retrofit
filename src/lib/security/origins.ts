import { routerOrigins } from "../keys/providers";
import { FIXTURE_PEER_ORIGINS } from "../test-fixtures/origins";
import type { PhaseOrigins } from "./headers";

/**
 * Origins the page may connect to beyond its own: the provider routers in the
 * key panel (Phase 4) and, in fixtures mode only, the loopback test peers.
 */
export function connectOrigins(): PhaseOrigins {
  return { origins: routerOrigins(), fixtureOrigins: FIXTURE_PEER_ORIGINS };
}
