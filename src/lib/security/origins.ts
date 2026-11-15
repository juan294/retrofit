import type { Config } from "../config";
import type { PhaseOrigins } from "./headers";

/** Origins later phases add to connect-src. Phase 1 adds none. */
export function connectOrigins(_config: Config): PhaseOrigins {
  return { origins: [], fixtureOrigins: [] };
}
