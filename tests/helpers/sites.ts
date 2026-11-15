import { startFixtureServer, type FixtureRoutes, type FixtureServer } from "./fixture-server";
import { materialize, type FixtureSite } from "../fixtures/sites";

/** Serves fixture sites on one loopback server, one host name per site. */
export async function serveSites(
  sites: (origins: (host: string) => string) => Record<string, FixtureSite>,
  options: { port?: number } = {},
): Promise<FixtureServer & { origin(host: string): string }> {
  const routes: FixtureRoutes = {};
  const holder: { server?: FixtureServer } = {};
  const origin = (host: string) => holder.server!.url(host, "").replace(/\/$/, "");
  const server = await startFixtureServer(routes, options);
  holder.server = server;
  for (const [host, site] of Object.entries(sites(origin))) {
    routes[host] = {};
    for (const [path, r] of Object.entries(materialize(site, origin(host)))) {
      routes[host][path] = { status: r.status, headers: r.headers, body: r.body };
    }
  }
  return Object.assign(server, { origin });
}
