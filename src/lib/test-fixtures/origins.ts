// Test-only origins for the local spec §6 harness (phase-4.md "Local spec §6 harness").
// Every host here resolves to loopback only in fixtures mode.

/** Synthetic peer sites, served by the fixture server on port 3011. */
export const PEER_A_ORIGIN = "http://peer-a.fixture.test:3011";
export const PEER_B_ORIGIN = "http://peer-b.fixture.test:3011";

/**
 * The two peer origins `buildConnectSrc` adds in fixtures mode. The third origin is
 * never added, so a fetch-guard failure is still caught by CSP as an unexpected violation.
 */
export const FIXTURE_PEER_ORIGINS = [PEER_A_ORIGIN, PEER_B_ORIGIN] as const;

/** Variants of peer-a's peer_demo, each under `<peer-a>/<variant>/` with its own manifest (tests/peer-fixture). */
export const PEER_A_VARIANTS = ["redirect-manifest", "hocon-third", "hocon-peer-b", "hocon-router", "network-redirect", "loop", "invalid"] as const;
export type PeerAVariant = (typeof PEER_A_VARIANTS)[number];

/** Never configured anywhere: redirect and absolute-hocon targets, on port 3013. */
export const THIRD_ORIGIN = "http://third.fixture.test:3013";

/**
 * Host-routed callers at the origin root of Retrofit's own server (port 3010). The
 * runtime matches a cycle back edge only when the caller network sits at an origin root
 * (research 2026-11-15-phase-4-entry.md §7), so the caller cannot live under a path.
 */
export const CALLER_E2E_HOST = "caller-e2e.fixture.test:3010";
export const CALLER_DENIED_HOST = "caller-denied.fixture.test:3010";
export const CALLER_HOSTS = [CALLER_E2E_HOST, CALLER_DENIED_HOST] as const;
export const CALLER_E2E_ORIGIN = `http://${CALLER_E2E_HOST}`;
export const CALLER_DENIED_ORIGIN = `http://${CALLER_DENIED_HOST}`;

/** Agent artifact paths that the fixture callers serve at their origin root (fixtures mode only). */
const CALLER_ARTIFACT = /^\/(agent-manifest\.json|[a-z0-9_]+\.network\.json|links\.json|site-actions\.js)$/;

/** True when the request hook must rewrite this request to the caller fixture route: fixtures mode, a caller host (host:port) and an artifact path. */
export function isCallerArtifactRequest(config: { readonly fixturesEnabled: boolean }, host: string, pathname: string): boolean {
  return config.fixturesEnabled && (CALLER_HOSTS as readonly string[]).includes(host.toLowerCase()) && CALLER_ARTIFACT.test(pathname);
}
