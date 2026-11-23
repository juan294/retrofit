import type { IncomingMessage, ServerResponse } from "node:http";
import { bakery, blocked, hostile, agentified, materialize, withClaimTags } from "../../tests/fixtures/sites";
import { serveSites } from "../../tests/helpers/sites";
import { peerSites, thirdSites } from "../../tests/peer-fixture";
import { OTARI_ROUTER_ORIGIN } from "./router-origin";
import { upstreamRoutes } from "./mock-upstream";

/** Port of the second loopback test origin (Archy port list). */
const FIXTURE_PORT = 3011;
/** Port of the third loopback test origin, never configured anywhere. */
const THIRD_PORT = 3013;
export const fixtureOrigin = (host: string) => `http://${host}:${FIXTURE_PORT}`;

/** Bakery copies whose home page carries the claim tags that specs register (e2e/claims.spec.ts). */
const TAGGED_HOSTS = ["claim.fixture.test", "flaky.fixture.test"] as const;

/**
 * Claims: a spec reads a claim's token from the account page and registers it with
 * GET http://127.0.0.1:3011/claim-tag?host=<host>&token=<token>; the host's home page then carries
 * a tag for every registered token. /claim-tag/clear?host=<host> removes them, so a spec can fail
 * three daily rechecks and then register the token again to pass one.
 */
export const CLAIM_TAG_URL = (action: "add" | "clear", host: string, token = "") =>
  `http://127.0.0.1:${FIXTURE_PORT}/claim-tag${action === "clear" ? "/clear" : ""}?${new URLSearchParams({ host, ...(token ? { token } : {}) })}`;

function claimTagRoutes() {
  const tokens = new Map<string, Set<string>>(TAGGED_HOSTS.map((h) => [h, new Set<string>()]));
  const home = (req: IncomingMessage, res: ServerResponse) => {
    const host = (req.headers.host ?? "").split(":")[0] ?? "";
    const page = materialize(withClaimTags(bakery, [...(tokens.get(host) ?? [])]), `http://${req.headers.host}`)["/"];
    res.writeHead(200, page?.headers ?? {}).end(page?.body ?? "");
  };
  const change = (clear: boolean) => (req: IncomingMessage, res: ServerResponse) => {
    const q = new URL(req.url ?? "/", "http://127.0.0.1").searchParams;
    const set = tokens.get(q.get("host") ?? "");
    const token = q.get("token") ?? "";
    if (!set || (!clear && !/^[0-9a-f]{32}$/.test(token))) {
      res.writeHead(400, { "content-type": "text/plain" }).end("host or token");
      return;
    }
    if (clear) set.clear();
    else set.add(token);
    res.writeHead(200, { "content-type": "text/plain" }).end(String(set.size));
  };
  return { ...Object.fromEntries(TAGGED_HOSTS.map((h) => [h, { "/": home }])), "127.0.0.1": { "/claim-tag": change(false), "/claim-tag/clear": change(true) } };
}

/**
 * Starts the synthetic fixture sites on 127.0.0.1:3011 for the whole run.
 * Chromium and the Next server both map *.fixture.test to loopback in fixtures mode.
 * It runs inside the Playwright process; the returned function stops it at global teardown.
 */
export default async function globalSetup() {
  const server = await serveSites(
    () => ({
      "bakery.fixture.test": bakery,
      "blocked.fixture.test": blocked,
      "hostile.fixture.test": hostile,
      "agentified.fixture.test": agentified,
      "claim.fixture.test": bakery,
      "flaky.fixture.test": bakery,
      "plain.fixture.test": bakery,
      ...peerSites({ routerOrigin: OTARI_ROUTER_ORIGIN }),
    }),
    { port: FIXTURE_PORT, extraRoutes: claimTagRoutes() },
  );
  // The third origin also hosts the mock Otari API on 127.0.0.1 (the free path's upstream, called by the server).
  const third = await serveSites(() => thirdSites(), { port: THIRD_PORT, extraRoutes: { "127.0.0.1": upstreamRoutes() } });
  return async () => {
    await server.close();
    await third.close();
  };
}
