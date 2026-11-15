import { loadConfig } from "@/lib/config";
import { crawlSite } from "@/lib/fetch/crawl";
import { createFetchContext } from "@/lib/fetch/context";
import type { Snapshot } from "@/lib/snapshot/types";
import { createMemoryStore } from "@/lib/store/memory";
import { agentified, bakery, hostile, noindexPage, spaOnly, type FixtureSite } from "../fixtures/sites";
import { serveSites } from "../helpers/sites";

const config = loadConfig({ SESSION_SECRET: "x".repeat(32), RETROFIT_TEST_FIXTURES: "1", FETCH_MAX_BYTES: "1048576" });

/** Every whole-site fixture that yields a snapshot (`blocked` stops at robots.txt). */
export const SITES = { bakery, spaOnly, agentified, hostile, noindexPage } satisfies Record<string, FixtureSite>;
export type SiteName = keyof typeof SITES;
const host = (name: string) => `${name.toLowerCase()}.fixture.test`;

/** Crawls every fixture site once, as tests/score/score.test.ts does, and returns the snapshots. */
export async function crawlFixtureSnapshots(): Promise<Map<SiteName, Snapshot>> {
  const server = await serveSites(() => Object.fromEntries(Object.entries(SITES).map(([name, site]) => [host(name), site])));
  try {
    const out = new Map<SiteName, Snapshot>();
    for (const name of Object.keys(SITES) as SiteName[]) {
      const fetch = createFetchContext({ config, store: createMemoryStore(), minIntervalMs: 1 });
      const snapshot = await crawlSite(server.origin(host(name)), { config, fetch, clock: Date.now });
      if (!snapshot) throw new Error(`no snapshot for ${name}`);
      out.set(name, snapshot);
    }
    return out;
  } finally {
    await server.close();
  }
}

export const PUBLIC_ORIGIN = "https://retrofit.test";
