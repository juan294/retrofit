import { bakery, blocked, hostile, agentified } from "../../tests/fixtures/sites";
import { serveSites } from "../../tests/helpers/sites";
import { peerSites, thirdSites } from "../../tests/peer-fixture";
import { OTARI_ROUTER_ORIGIN } from "./router-origin";

/** Port of the second loopback test origin (Archy port list). */
export const FIXTURE_PORT = 3011;
/** Port of the third loopback test origin, never configured anywhere. */
export const THIRD_PORT = 3013;
export const fixtureOrigin = (host: string) => `http://${host}:${FIXTURE_PORT}`;

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
      ...peerSites({ routerOrigin: OTARI_ROUTER_ORIGIN }),
    }),
    { port: FIXTURE_PORT },
  );
  const third = await serveSites(() => thirdSites(), { port: THIRD_PORT });
  return async () => {
    await server.close();
    await third.close();
  };
}
