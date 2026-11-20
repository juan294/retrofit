import { routerOrigins } from "../keys/providers";
import { PEER_ORIGIN } from "../peer/host";
import { FIXTURE_PEER_ORIGINS } from "../test-fixtures/origins";
import type { PhaseOrigins } from "./headers";

/**
 * Origins the page may connect to beyond its own: the provider routers in the
 * key panel (Phase 4), the production peer Harbor tours demo (Phase 7) and, in
 * fixtures mode only, the loopback test peers. The demo-denied conformance origin
 * is never added, so CSP also blocks it.
 */
export function connectOrigins(): PhaseOrigins {
  return { origins: [...routerOrigins(), PEER_ORIGIN], fixtureOrigins: FIXTURE_PEER_ORIGINS };
}
