import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "@/lib/config";
import { crawlSite, LeaseLost } from "@/lib/fetch/crawl";
import { createFetchContext } from "@/lib/fetch/context";
import { createMemoryStore } from "@/lib/store/memory";
import { agentified, bakery, hostile, INJECTION, noindexPage, type FixtureSite } from "../fixtures/sites";
import { validateSnapshot } from "@/lib/snapshot/types";
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
    // The injection phrase appears only in page data fields and records, never in a control field.
    const home = snapshot.pages[0]!;
    expect(home.title).toContain(INJECTION);
    const hits: string[] = [];
    const walk = (v: unknown, path: string) => {
      if (typeof v === "string") {
        if (v.includes(INJECTION)) hits.push(path);
      } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
      else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
    };
    walk(snapshot, "$");
    expect(hits.length).toBeGreaterThan(0);
    const dataField = /^\$\.(pages\[\d+\]\.(title|text|description|jsonLd.*|records\..*|links\[\d+\]\.text)|records\..*)$/;
    expect(hits.filter((h) => !dataField.test(h))).toEqual([]);
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

  // Fails if a page that redirects to a sign-in path is extracted.
  it("skips a page whose redirect lands on a private path", async () => {
    const site: FixtureSite = {
      ...bakery,
      "/": { headers: { "content-type": "text/html" }, body: `<main>home <a href="/members">Members</a></main>` },
      "/members": { status: 302, headers: { location: "/login" } },
    };
    const { snapshot } = await crawl({ "bakery.fixture.test": site }, "bakery.fixture.test");
    expect(snapshot.pages.map((p) => new URL(p.url).pathname)).toEqual(["/"]);
    expect(snapshot.skipped.find((s) => s.url.endsWith("/members"))?.reason).toBe("private-path");
  });

  // Fails if a large Crawl-delay makes the worker sleep (losing its lease) instead of stopping early.
  it("reads only the home page when Crawl-delay is above the limit", async () => {
    const site: FixtureSite = { ...bakery, "/robots.txt": { headers: { "content-type": "text/plain" }, body: "User-agent: *\nCrawl-delay: 30\nAllow: /\n" } };
    const server = await serveSites(() => ({ "slow.fixture.test": site }));
    close = () => server.close();
    const store = createMemoryStore();
    const base = createFetchContext({ config, store, minIntervalMs: 1 });
    const waits: (number | undefined)[] = [];
    const fetch = { ...base, pace: async (h: string, d?: number) => void waits.push(d) };
    const { createRobots } = await import("@/lib/fetch/robots");
    const snapshot = (await crawlSite(server.origin("slow.fixture.test"), { config, fetch: { ...fetch, robots: createRobots({ config, store, pace: fetch.pace }) }, clock: Date.now }))!;
    expect(snapshot.pages).toHaveLength(1);
    expect(snapshot.probes.sitemap.status).toBeNull();
    expect(snapshot.skipped.filter((s) => s.reason === "crawl-delay").length).toBeGreaterThan(0);
    expect(server.requests.map((r) => r.path)).toEqual(["/robots.txt", "/"]);
    // Fails if a wait longer than the cap is requested (it would outlast the lease).
    expect(Math.max(...waits.map((w) => w ?? 0))).toBe(10);
  });

  // Fails if kept header values are not clipped (an oversized header would fail validation and the crawl).
  it("clips oversized kept headers", async () => {
    const long = `text/html; x=${"a".repeat(5000)}`;
    const site: FixtureSite = { ...bakery, "/menu": { headers: { "content-type": long }, body: "<main>menu</main>" }, "/llms.txt": { headers: { "content-type": `text/plain; y=${"b".repeat(5000)}` }, body: "x" } };
    const { snapshot } = await crawl({ "bakery.fixture.test": site }, "bakery.fixture.test");
    expect(snapshot.pages.find((p) => p.url.endsWith("/menu"))?.headers["content-type"]?.length).toBe(1024);
    expect(snapshot.probes.llmsTxt.contentType?.length).toBe(1024);
  });

  // Fails if probe bodies keep email addresses.
  it("scrubs email addresses from probe bodies", async () => {
    const site: FixtureSite = { ...bakery, "/llms.txt": { headers: { "content-type": "text/plain" }, body: "# Bakery\nContact owner@crumb.example\n" } };
    const { snapshot } = await crawl({ "bakery.fixture.test": site }, "bakery.fixture.test");
    expect(snapshot.probes.llmsTxt.body).toContain("[email removed]");
    expect(snapshot.probes.llmsTxt.body).not.toContain("owner@crumb.example");
  });

  // Fails if the declared network is not fetched after the manifest, fetched without a progress step, or kept out of the snapshot.
  it("records the network the manifest declares, and nothing for a site without one", async () => {
    const steps: string[] = [];
    const { snapshot, server } = await crawl({ "kayak.fixture.test": agentified }, "kayak.fixture.test", { progress: async (s) => (steps.push(s), true) });
    const network = snapshot.probes.network!;
    expect(network.url).toBe(`${server.origin("kayak.fixture.test")}/kayak_guide.network.json`);
    expect(network.status).toBe(200);
    expect(JSON.parse(network.body!).tools[0].name).toBe("kayak_guide");
    expect(steps.indexOf("probe network")).toBeGreaterThan(steps.indexOf("probe /agent-manifest.json"));
    expect(validateSnapshot(snapshot).probes.network).toEqual(network);
    const { network: _dropped, ...older } = snapshot.probes;
    expect(validateSnapshot({ ...snapshot, probes: older }).probes).not.toHaveProperty("network");
    await close?.();
    const plain = await crawl({ "bakery.fixture.test": bakery }, "bakery.fixture.test");
    expect(plain.snapshot.probes).not.toHaveProperty("network");
  });

  // Fails if the crawl ignores a lost lease reported between pages.
  it("stops with LeaseLost when the progress hook reports the lease lost", async () => {
    await expect(crawl({ "bakery.fixture.test": bakery }, "bakery.fixture.test", { progress: async (s) => !s.startsWith("probe ") })).rejects.toBeInstanceOf(LeaseLost);
  });
});
