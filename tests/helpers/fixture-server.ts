import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** A static response. `status` defaults to 200 and `body` to "". */
export interface FixtureResponse {
  readonly status?: number;
  readonly headers?: Record<string, string | string[]>;
  readonly body?: string | Buffer;
}

export type FixtureHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

/** hostname (no port) -> path (pathname plus search, or pathname alone) -> handler or static response. */
export type FixtureRoutes = Record<string, Record<string, FixtureHandler | FixtureResponse>>;

export interface FixtureRequest {
  readonly host: string;
  readonly path: string;
  readonly headers: IncomingMessage["headers"];
}

export interface FixtureServer {
  readonly port: number;
  /** Absolute URL for `host` (for example "127.0.0.1", "localhost" or "bakery.fixture.test") on this server. */
  url(host: string, path?: string): string;
  /** Every request received, in order. */
  readonly requests: FixtureRequest[];
  close(): Promise<void>;
}

function hostnameOf(req: IncomingMessage): string {
  const raw = (req.headers.host ?? "").toLowerCase();
  const colon = raw.lastIndexOf(":");
  return colon === -1 ? raw : raw.slice(0, colon);
}

/**
 * Loopback HTTP server on an ephemeral port (or `options.port`). Routes by the Host header, so
 * 127.0.0.1, localhost and any number of <label>.fixture.test names act as
 * separate hosts. Unknown hosts and paths answer 404.
 */
export async function startFixtureServer(routes: FixtureRoutes, options: { port?: number } = {}): Promise<FixtureServer> {
  const requests: FixtureRequest[] = [];
  const server = createServer((req, res) => {
    const host = hostnameOf(req);
    const full = req.url ?? "/";
    const pathname = full.split("?")[0] ?? "/";
    requests.push({ host, path: full, headers: req.headers });
    const hostRoutes = routes[host];
    const route = hostRoutes?.[full] ?? hostRoutes?.[pathname];
    if (!route) {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found");
      return;
    }
    if (typeof route === "function") {
      Promise.resolve(route(req, res)).catch(() => res.destroy());
      return;
    }
    res.writeHead(route.status ?? 200, route.headers ?? {}).end(route.body ?? "");
  });
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    requests,
    url: (host, path = "/") => `http://${host}:${port}${path}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
