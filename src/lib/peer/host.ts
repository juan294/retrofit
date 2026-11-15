// The synthetic production peer "Harbor tours demo" (phase-7.md, "Production peer").
// The same deployment serves it, but only for requests whose Host is the peer host; the
// request hook (src/proxy.ts) rewrites those to the peer route, which checks the Host again.

/** Retrofit's own public origin, which harbor_loop calls back. */
export const RETROFIT_ORIGIN = "https://retrofit.thecreativetoken.com";

/** The production peer host and origin. */
export const PEER_HOST = "demo-harbor.thecreativetoken.com";
export const PEER_ORIGIN = `https://${PEER_HOST}`;

/**
 * Loopback stand-in for the peer host on the Playwright server (port 3010), fixtures mode
 * only, so e2e can map the peer origin to this server.
 */
export const PEER_FIXTURE_HOST = "demo-harbor.fixture.test:3010";

/** Internal route that serves peers/demo-harbor/public/. */
export const PEER_ROUTE = "/peer";

/** True when the Host header value (host[:port]) is the peer host, or the fixture host in fixtures mode. */
export function isPeerHost(host: string, config: { readonly fixturesEnabled: boolean }): boolean {
  const h = host.toLowerCase();
  return h === PEER_HOST || (config.fixturesEnabled && h === PEER_FIXTURE_HOST);
}

/**
 * The internal path the request hook rewrites a peer-host request to, or null for every
 * other host. Every path on the peer host goes to the peer route (which answers 404 for
 * files it does not publish), so the peer host never serves Retrofit's own pages.
 */
export function peerHostRewrite(host: string, pathname: string, config: { readonly fixturesEnabled: boolean }): string | null {
  if (!isPeerHost(host, config)) return null;
  return `${PEER_ROUTE}${pathname === "/" ? "/index.html" : pathname}`;
}
