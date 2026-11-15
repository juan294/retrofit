import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "@/lib/config";
import { crawlSite, isPrivatePath, LeaseLost } from "@/lib/fetch/crawl";
import { createFetchContext } from "@/lib/fetch/context";
import { CrawlDelayTooLong, PrivatePathRefused } from "@/lib/fetch/errors";
import { guardedFetch, type FetchContext } from "@/lib/fetch/http";
import { createPacer } from "@/lib/fetch/pacing";
import { createRobots } from "@/lib/fetch/robots";
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

/**
 * A fetch context on a fake clock: the real store-backed pacer sleeps by moving the clock, and
 * `starts` records the clock when each request leaves the pacer (just before it is sent).
 */
function fakeTimeContext() {
  let now = Date.parse("2026-11-15T10:00:00Z");
  const clock = () => now;
  const store = createMemoryStore({ clock });
  const pacer = createPacer({ store, clock, sleep: async (ms) => void (now += ms), minIntervalMs: 1000 });
  const starts: { host: string; at: number }[] = [];
  const pace = async (host: string, delay?: number, notAfter?: number) => {
    await pacer.pace(host, delay, notAfter);
    starts.push({ host, at: now });
  };
  const fetch: FetchContext = { config, store, pace, robots: createRobots({ config, store, pace, clock }) };
  return { fetch, clock, starts, startedAt: now };
}

const gaps = (xs: { at: number }[]) => xs.slice(1).map((x, i) => x.at - (xs[i] as { at: number }).at);

async function crawl(sites: Record<string, FixtureSite>, host: string, hooks?: Parameters<typeof crawlSite>[1]["hooks"]) {
  const server = await serveSites(() => sites);
  close = () => server.close();
  const store = createMemoryStore();
  const fetch = createFetchContext({ config, store, minIntervalMs: 1 });
  const snapshot = await crawlSite(server.origin(host), { config, fetch, clock: Date.now, hooks });
  return { snapshot: snapshot!, server };
}

describe("isPrivatePath", () => {
  // Fails if the private-path rule is checked on the encoded form, or a malformed encoding is let through (F2).
  it.each([
    ["/login", true],
    ["/%6Cogin", true],
    ["/%6c%6F%67%69%6E", true],
    ["/shop/%63art/", true],
    ["/a%2Flogin", true],
    ["/%E0%A4%A", true],
    ["/menu", false],
    ["/blog/catalogue", false],
    ["/%6Denu", false],
  ])("%s is private: %s", (path, expected) => {
    expect(isPrivatePath(path)).toBe(expected);
  });
});

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
    const { snapshot, server } = await crawl({ "bakery.fixture.test": site }, "bakery.fixture.test");
    expect(snapshot.pages.map((p) => new URL(p.url).pathname)).toEqual(["/"]);
    expect(snapshot.skipped.find((s) => s.url.endsWith("/members"))?.reason).toBe("private-path");
    // Fails if the redirect hop to the private path is requested before the path rule applies (validation V06).
    expect(server.requests.map((r) => r.path)).toContain("/members");
    expect(server.requests.map((r) => r.path)).not.toContain("/login");
  });

  // Fails if a home page that redirects to a sign-in path is requested or extracted.
  it("never contacts a private path that the home page redirects to", async () => {
    const site: FixtureSite = { ...bakery, "/": { status: 302, headers: { location: "/account/login?next=%2F" } } };
    const server = await serveSites(() => ({ "gated.fixture.test": site }));
    close = () => server.close();
    const fetch = createFetchContext({ config, store: createMemoryStore(), minIntervalMs: 1 });
    const err = await crawlSite(server.origin("gated.fixture.test"), { config, fetch, clock: Date.now }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PrivatePathRefused);
    expect(server.requests.map((r) => r.path)).toEqual(["/robots.txt", "/"]);
  });

  // Fails if a probe or the declared network is fetched on a private path, directly or through a redirect.
  it("never requests a private path for a probe or the declared network", async () => {
    const site: FixtureSite = {
      ...agentified,
      "/llms.txt": { status: 301, headers: { location: "/login?next=llms" } },
      "/agent-manifest.json": {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ networks: [{ name: "n", front_man: "n", hocon: "/account/network.json" }] }),
      },
    };
    const { snapshot, server } = await crawl({ "kayak.fixture.test": site }, "kayak.fixture.test");
    const paths = server.requests.map((r) => r.path);
    expect(paths).toContain("/llms.txt");
    expect(paths.filter((p) => isPrivatePath(p.split("?")[0] as string))).toEqual([]);
    expect(snapshot.probes.llmsTxt.status).toBeNull();
  });

  // Fails if percent-encoding a private path (/%6Cogin) gets it past the path rule, in a link or a redirect hop (F2).
  it("never requests a percent-encoded or malformed private path from a link or a redirect", async () => {
    const site: FixtureSite = {
      ...bakery,
      "/": { headers: { "content-type": "text/html" }, body: `<main><a href="/%6Cogin">a</a> <a href="/%E0%A4%A">b</a> <a href="/members">c</a> <a href="/menu">d</a></main>` },
      "/members": { status: 302, headers: { location: "/%61ccount/settings" } },
      "/menu": { headers: { "content-type": "text/html" }, body: "<main>menu</main>" },
    };
    const { snapshot, server } = await crawl({ "bakery.fixture.test": site }, "bakery.fixture.test");
    const paths = server.requests.map((r) => r.path);
    for (const p of ["/%6Cogin", "/%E0%A4%A", "/%61ccount/settings"]) expect(paths).not.toContain(p);
    expect(paths).toContain("/members");
    expect(paths).toContain("/menu");
    const reasons = Object.fromEntries(snapshot.skipped.map((s) => [new URL(s.url).pathname, s.reason]));
    expect(reasons).toMatchObject({ "/%6Cogin": "private-path", "/%E0%A4%A": "private-path", "/members": "private-path" });
  });

  // Fails if guardedFetch contacts a private path when given the path rule.
  it("guardedFetch refuses a private path before any request", async () => {
    const server = await serveSites(() => ({ "bakery.fixture.test": bakery }));
    close = () => server.close();
    const fetch = createFetchContext({ config, store: createMemoryStore(), minIntervalMs: 1 });
    const err = await guardedFetch(new URL(`${server.origin("bakery.fixture.test")}/cart`), fetch, { privatePath: isPrivatePath }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PrivatePathRefused);
    expect(server.requests).toEqual([]);
  });

  // Fails if a requested Crawl-delay is shortened (validation V07: a 30 s delay got a 10 s wait), or if
  // requests continue once the next one would start after the crawl budget.
  it("waits the full 30 s Crawl-delay, then stops before a request that would pass the budget", async () => {
    const site: FixtureSite = { ...bakery, "/robots.txt": { headers: { "content-type": "text/plain" }, body: "User-agent: *\nCrawl-delay: 30\nAllow: /\n" } };
    const server = await serveSites(() => ({ "slow.fixture.test": site }));
    close = () => server.close();
    const t = fakeTimeContext();
    const snapshot = (await crawlSite(server.origin("slow.fixture.test"), { config, fetch: t.fetch, clock: t.clock }))!;
    expect(server.requests.map((r) => r.path)).toEqual(["/robots.txt", "/"]);
    expect(gaps(t.starts)).toEqual([30_000]);
    expect(snapshot.pages).toHaveLength(1);
    expect(snapshot.probes.sitemap.status).toBeNull();
    expect(snapshot.skipped.filter((s) => s.reason === "crawl-delay").length).toBeGreaterThan(0);
  });

  // Fails if a moderate delay is shortened or if any request starts after the crawl budget ends.
  it("keeps a 12 s Crawl-delay between every request and starts none after the budget", async () => {
    const site: FixtureSite = { ...bakery, "/robots.txt": { headers: { "content-type": "text/plain" }, body: "User-agent: *\nCrawl-delay: 12\nAllow: /\n" } };
    const server = await serveSites(() => ({ "slow.fixture.test": site }));
    close = () => server.close();
    const t = fakeTimeContext();
    await crawlSite(server.origin("slow.fixture.test"), { config, fetch: t.fetch, clock: t.clock });
    expect(t.starts.length).toBeGreaterThan(2);
    for (const gap of gaps(t.starts)) expect(gap).toBeGreaterThanOrEqual(12_000);
    for (const s of t.starts) expect(s.at - t.startedAt).toBeLessThanOrEqual(config.crawlBudgetMs);
    expect(server.requests).toHaveLength(t.starts.length);
  });

  // Fails if a Crawl-delay longer than the whole budget makes the worker sleep past its lease,
  // or if the home page is requested anyway.
  it("stops before the home page when the Crawl-delay cannot fit the budget", async () => {
    const site: FixtureSite = { ...bakery, "/robots.txt": { headers: { "content-type": "text/plain" }, body: "User-agent: *\nCrawl-delay: 60\nAllow: /\n" } };
    const server = await serveSites(() => ({ "slower.fixture.test": site }));
    close = () => server.close();
    const t = fakeTimeContext();
    const err = await crawlSite(server.origin("slower.fixture.test"), { config, fetch: t.fetch, clock: t.clock }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CrawlDelayTooLong);
    expect(server.requests.map((r) => r.path)).toEqual(["/robots.txt"]);
    expect(t.clock() - t.startedAt).toBeLessThan(config.crawlBudgetMs);
  });

  // Fails if the production fetch context (createFetchContext) drops the deadline, so the worker
  // sleeps a 60 s Crawl-delay with the real clock (review of the V07 repair).
  it("stops at once through createFetchContext when the Crawl-delay cannot fit the budget", { timeout: 5000 }, async () => {
    const site: FixtureSite = { ...bakery, "/robots.txt": { headers: { "content-type": "text/plain" }, body: "User-agent: *\nCrawl-delay: 60\nAllow: /\n" } };
    const server = await serveSites(() => ({ "slower.fixture.test": site }));
    close = () => server.close();
    const fetch = createFetchContext({ config, store: createMemoryStore(), minIntervalMs: 1 });
    const err = await crawlSite(server.origin("slower.fixture.test"), { config, fetch, clock: Date.now }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CrawlDelayTooLong);
    expect(server.requests.map((r) => r.path)).toEqual(["/robots.txt"]);
  });

  // Fails if a robots.txt redirect to a private path is followed (review of the V06 repair).
  it("never follows a robots.txt redirect to a private path", async () => {
    const site: FixtureSite = { ...bakery, "/robots.txt": { status: 302, headers: { location: "/login?next=robots" } } };
    const server = await serveSites(() => ({ "gated.fixture.test": site }));
    close = () => server.close();
    const fetch = createFetchContext({ config, store: createMemoryStore(), minIntervalMs: 1 });
    await crawlSite(server.origin("gated.fixture.test"), { config, fetch, clock: Date.now }).catch(() => null);
    expect(server.requests.map((r) => r.path)).toEqual(["/robots.txt"]);
  });

  // Fails if a crawl delay refusal on another host (the declared network's host, or an off-host
  // redirect) stops the main host's remaining pages (F4).
  it("keeps reading the main host after another host's crawl delay refuses a request", async () => {
    const slowRobots = { headers: { "content-type": "text/plain" }, body: "User-agent: *\nCrawl-delay: 50\nAllow: /\n" };
    const server = await serveSites((o) => ({
      "main.fixture.test": {
        ...bakery,
        "/": { headers: { "content-type": "text/html" }, body: `<main><a href="/away">away</a> <a href="/menu">menu</a> <a href="/order">order</a></main>` },
        "/away": { status: 302, headers: { location: `${o("far.fixture.test")}/page` } },
        "/agent-manifest.json": {
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ networks: [{ name: "n", front_man: "n", hocon: `${o("net.fixture.test")}/n.json` }] }),
        },
      },
      "net.fixture.test": { "/robots.txt": slowRobots, "/n.json": { headers: { "content-type": "application/json" }, body: "{}" } },
      "far.fixture.test": { "/robots.txt": slowRobots, "/page": { headers: { "content-type": "text/html" }, body: "<main>far</main>" } },
    }));
    close = () => server.close();
    const t = fakeTimeContext();
    // The other hosts' robots.txt was read just now, so their next request must wait 50 s.
    await t.fetch.robots.check(new URL(`${server.origin("net.fixture.test")}/`));
    await t.fetch.robots.check(new URL(`${server.origin("far.fixture.test")}/`));
    const snapshot = (await crawlSite(server.origin("main.fixture.test"), { config, fetch: t.fetch, clock: t.clock }))!;
    expect(snapshot.probes.network?.status ?? null).toBeNull();
    expect(snapshot.skipped.find((x) => x.url.endsWith("/away"))?.reason).toBe("crawl-delay");
    expect(snapshot.pages.map((p) => new URL(p.url).pathname).sort()).toEqual(["/", "/menu", "/order"]);
    expect(server.requests.filter((r) => r.host !== "main.fixture.test").map((r) => r.path)).toEqual(["/robots.txt", "/robots.txt"]);
  });

  // Fails if a redirect chain is not bounded as a whole: a hop to a host with a long delay must be
  // refused before contact when its wait would pass the deadline (plan notes, delayed redirect chains).
  it("refuses a redirect hop whose host delay would pass the deadline", async () => {
    const server = await serveSites((o) => ({
      "start.fixture.test": { "/robots.txt": { headers: { "content-type": "text/plain" }, body: "User-agent: *\nAllow: /\n" }, "/": { status: 301, headers: { location: `${o("far.fixture.test")}/` } } },
      "far.fixture.test": { ...bakery, "/robots.txt": { headers: { "content-type": "text/plain" }, body: "User-agent: *\nCrawl-delay: 50\nAllow: /\n" } },
    }));
    close = () => server.close();
    const t = fakeTimeContext();
    const err = await crawlSite(server.origin("start.fixture.test"), { config, fetch: t.fetch, clock: t.clock }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CrawlDelayTooLong);
    expect(server.requests.map((r) => `${r.host}${r.path}`)).toEqual(["start.fixture.test/robots.txt", "start.fixture.test/", "far.fixture.test/robots.txt"]);
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
