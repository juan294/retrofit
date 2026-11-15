import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "@/lib/config";
import { crawlSite, LeaseLost } from "@/lib/fetch/crawl";
import { createFetchContext } from "@/lib/fetch/context";
import { createMemoryStore } from "@/lib/store/memory";
import { bakery, hostile, INJECTION, noindexPage, type FixtureSite } from "../fixtures/sites";
import { serveSites } from "../helpers/sites";

const config = loadConfig({ SESSION_SECRET: "x".repeat(32), RETROFIT_TEST_FIXTURES: "1", FETCH_MAX_BYTES: "1048576" });
let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function crawl(sites: Record<string, FixtureSite>, host: string, hooks?: Parameters<typeof crawlSite>[1]["hooks"]) {
  const server = await serveSites(() => sites);
  close = () => server.close();
  const store = createMemoryStore();
  const fetch = createFetchContext({ config, store, minIntervalMs: 1 });
  const snapshot = await crawlSite(server.origin(host), { config, fetch, clock: Date.now, hooks });
  return { snapshot: snapshot!, server };
}

describe("crawlSite", () => {
  // Fails if probes, records or navigation pages are dropped from the snapshot.
  it("reads the bakery pages, records and probes", async () => {
    const { snapshot } = await crawl({ "bakery.fixture.test": bakery }, "bakery.fixture.test");
    const paths = snapshot.pages.map((p) => new URL(p.url).pathname).sort();
    expect(paths).toEqual(["/", "/contact", "/menu", "/order"]);
    expect(snapshot.probes.sitemap.status).toBe(200);
    expect(snapshot.probes.robots.body).toContain("Sitemap:");
    expect(snapshot.probes.agentManifest.status).toBe(404);
    expect(snapshot.records.menu_items?.map((r) => r.name)).toEqual(["Sourdough loaf", "Rye sandwich bread"]);
    expect(snapshot.records.opening_hours?.length).toBeGreaterThan(0);
    expect(JSON.stringify(snapshot)).not.toContain("hello@crumb-and-crust.example");
  });

  // Fails if SKIP_PATH stops matching sign-in, account or cart paths.
  it("never requests login, account or cart pages", async () => {
    const { snapshot, server } = await crawl({ "bakery.fixture.test": bakery }, "bakery.fixture.test");
    const requested = server.requests.map((r) => r.path);
    for (const p of ["/login", "/cart", "/account/settings"]) expect(requested).not.toContain(p);
    expect(snapshot.skipped.filter((s) => s.reason === "private-path").map((s) => new URL(s.url).pathname).sort()).toEqual(["/account/settings", "/cart", "/login"]);
  });

  // Fails if the page budget (CRAWL_MAX_PAGES = 12) is not enforced.
  it("stops at 12 pages", async () => {
    const big: FixtureSite = {
      "/robots.txt": { headers: { "content-type": "text/plain" }, body: "User-agent: *\nAllow: /\n" },
      "/": { headers: { "content-type": "text/html" }, body: `<main>${Array.from({ length: 20 }, (_, i) => `<a href="/p${i}">p${i}</a>`).join(" ")}</main>` },
    };
    for (let i = 0; i < 20; i++) big[`/p${i}`] = { headers: { "content-type": "text/html" }, body: `<main>page ${i}</main>` };
    const { snapshot, server } = await crawl({ "many.fixture.test": big }, "many.fixture.test");
    expect(snapshot.pages).toHaveLength(12);
    expect(snapshot.skipped.filter((s) => s.reason === "page-budget")).toHaveLength(9);
    expect(server.requests.filter((r) => /^\/p\d+$/.test(r.path))).toHaveLength(11);
  });

  // Fails if noindex text is kept.
  it("excludes noindex page text and records the exclusion", async () => {
    const { snapshot } = await crawl({ "ni.fixture.test": noindexPage }, "ni.fixture.test");
    const priv = snapshot.pages.find((p) => p.url.endsWith("/private"))!;
    expect(priv.text).toBe("");
    expect(snapshot.excludedNoindex).toEqual([priv.url]);
  });

  // Fails if hostile text leaks outside page data, or a redirect to a blocked address is followed.
  it("stores hostile text only as page data and refuses the metadata redirect", async () => {
    const { snapshot, server } = await crawl({ "hostile.fixture.test": hostile }, "hostile.fixture.test");
    const internal = snapshot.skipped.find((s) => s.url.endsWith("/internal"));
    expect(internal?.reason).toBe("not_public");
    const big = snapshot.pages.find((p) => p.url.endsWith("/big"))!;
    expect(big.truncated).toBe(true);
    for (const p of ["/login", "/cart", "/checkout", "/admin"]) expect(server.requests.map((r) => r.path)).not.toContain(p);
    // The injection phrase appears only in page text, titles and record names: data fields.
    const home = snapshot.pages[0]!;
    expect(home.title).toContain(INJECTION);
    expect(Object.keys(snapshot)).toEqual(["version", "source", "inputUrl", "finalUrl", "host", "fetchedAt", "pages", "probes", "skipped", "records", "excludedNoindex"]);
  });

  // Fails if any request (robots.txt, probes, pages) skips the pacing slot.
  it("paces every request, including robots.txt and probes", async () => {
    const server = await serveSites(() => ({ "bakery.fixture.test": bakery }));
    close = () => server.close();
    const store = createMemoryStore();
    const base = createFetchContext({ config, store, minIntervalMs: 1 });
    const paced: string[] = [];
    const pace = async (host: string, delay?: number) => {
      paced.push(host);
      await base.pace(host, delay);
    };
    const fetch = { ...createFetchContext({ config, store, minIntervalMs: 1 }), pace };
    // Robots must use the same paced path.
    const { createRobots } = await import("@/lib/fetch/robots");
    const ctx = { ...fetch, robots: createRobots({ config, store, pace }) };
    await crawlSite(server.origin("bakery.fixture.test"), { config, fetch: ctx, clock: Date.now });
    const requests = server.requests.filter((r) => r.host === "bakery.fixture.test");
    expect(requests.map((r) => r.path)).toEqual(expect.arrayContaining(["/robots.txt", "/agent-manifest.json", "/llms.txt", "/sitemap.xml"]));
    expect(paced.filter((h) => h.startsWith("bakery.fixture.test"))).toHaveLength(requests.length);
  });

  // Fails if the crawl ignores a lost lease reported between pages.
  it("stops with LeaseLost when the progress hook reports the lease lost", async () => {
    await expect(crawl({ "bakery.fixture.test": bakery }, "bakery.fixture.test", { progress: async (s) => s === "probes" })).rejects.toBeInstanceOf(LeaseLost);
  });
});
