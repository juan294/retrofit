import type { IncomingMessage, ServerResponse } from "node:http";
import { FIXTURE_CLAIM_TOKEN } from "@/lib/claims/host";
import { bakery, blocked, hostile, agentified, materialize, withClaimTag } from "../../tests/fixtures/sites";
import { serveSites } from "../../tests/helpers/sites";
import { peerSites, thirdSites } from "../../tests/peer-fixture";
import { OTARI_ROUTER_ORIGIN } from "./router-origin";
import { upstreamRoutes } from "./mock-upstream";

/** Port of the second loopback test origin (Archy port list). */
const FIXTURE_PORT = 3011;
/** Port of the third loopback test origin, never configured anywhere. */
const THIRD_PORT = 3013;
export const fixtureOrigin = (host: string) => `http://${host}:${FIXTURE_PORT}`;

/**
 * Claims (e2e/claims.spec.ts): claim.fixture.test always carries the fixtures-mode claim tag;
 * flaky.fixture.test carries it while the tag is on. GET http://127.0.0.1:3011/claim-tag/off (or /on)
 * removes or restores it, so a spec can fail three daily rechecks and then pass one.
 */
export const CLAIM_TAG_SWITCH = (on: boolean) => `http://127.0.0.1:${FIXTURE_PORT}/claim-tag/${on ? "on" : "off"}`;

function claimTagRoutes() {
  let on = true;
  const tagged = withClaimTag(bakery, FIXTURE_CLAIM_TOKEN);
  const home = (req: IncomingMessage, res: ServerResponse) => {
    const page = materialize(on ? tagged : bakery, `http://${req.headers.host}`)["/"];
    res.writeHead(200, page?.headers ?? {}).end(page?.body ?? "");
  };
  const set = (value: boolean) => (_req: IncomingMessage, res: ServerResponse) => {
    on = value;
    res.writeHead(200, { "content-type": "text/plain" }).end(value ? "on" : "off");
  };
  return { "flaky.fixture.test": { "/": home }, "127.0.0.1": { "/claim-tag/on": set(true), "/claim-tag/off": set(false) } };
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
      "claim.fixture.test": withClaimTag(bakery, FIXTURE_CLAIM_TOKEN),
      "flaky.fixture.test": bakery,
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
