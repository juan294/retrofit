import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, type Config } from "@/lib/config";
import { createFetchContext } from "@/lib/fetch/context";
import { CrawlDelayTooLong, FetchTimeoutError, NotPublicError, RobotsBlocked, TooManyRedirects } from "@/lib/fetch/errors";
import type { Resolver } from "@/lib/fetch/guard";
import { guardedFetch, rawGuardedGet, type FetchContext } from "@/lib/fetch/http";
import { createRobots } from "@/lib/fetch/robots";
import { validateUrl } from "@/lib/fetch/url";
import { createMemoryStore } from "@/lib/store/memory";
import type { Store } from "@/lib/store/types";
import { startFixtureServer, type FixtureRoutes, type FixtureServer } from "../helpers/fixture-server";
import { noRealDns } from "../helpers/server-deps";

const config: Config = loadConfig({
  RETROFIT_TEST_FIXTURES: "1",
  SESSION_SECRET: "x".repeat(32),
  FETCH_TIMEOUT_MS: "400",
  PUBLIC_ORIGIN: "https://retrofit.example",
});

const FIVE_MB = 5 * 1024 * 1024;
const routes: FixtureRoutes = {};
let server: FixtureServer;
let paced: string[];

function context(overrides: Partial<FetchContext> = {}): FetchContext {
  const store = createMemoryStore();
  const pace = async (host: string) => {
    paced.push(host);
  };
  const lookup = overrides.lookup ?? noRealDns;
  const robots = createRobots({ config, store, pace, lookup });
  return { config, store, robots, pace, lookup, ...overrides };
}

const u = (host: string, path = "/") => validateUrl(server.url(host, path), config);
const html = (body: string, extra: Record<string, string> = {}) => ({ headers: { "content-type": "text/html; charset=utf-8", ...extra }, body });
const redirect = (location: string, status = 302) => ({ status, headers: { location } });

beforeAll(async () => {
  server = await startFixtureServer(routes);
  const loc = (host: string, path: string) => server.url(host, path);
  Object.assign(routes, {
    "site.fixture.test": {
      "/": html("<h1>Home</h1>", { "set-cookie": "sid=abc", "x-robots-tag": "noarchive", "x-secret": "drop-me" }),
      "/image": { headers: { "content-type": "image/png" }, body: Buffer.alloc(64) },
      "/json": { headers: { "content-type": "application/json" }, body: '{"a":1}' },
      "/big": html("a".repeat(FIVE_MB)),
      "/hang": () => {
        /* never answers */
      },
      "/slow-body": (_req, res) => {
        res.writeHead(200, { "content-type": "text/html" });
        res.write("<p>start");
        /* never ends */
      },
      "/to-metadata": redirect("http://169.254.169.254/latest/meta-data/"),
      "/to-private-literal": redirect("http://10.0.0.5/"),
      "/to-private-name": redirect("http://internal.example.com/"),
      "/to-fixture-private": redirect(loc("127.0.0.1", "/").replace("127.0.0.1", "10.0.0.5")),
      "/cookie-hop": { status: 302, headers: { location: "/echo", "set-cookie": "sid=abc" } },
      "/echo": (req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ cookie: req.headers.cookie ?? null, ua: req.headers["user-agent"], enc: req.headers["accept-encoding"] }));
      },
      "/cross": redirect(loc("other.fixture.test", "/landing")),
      ...Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`/chain${i + 1}`, redirect(i + 1 < 6 ? `/chain${i + 2}` : "/done")])),
      "/done": html("done"),
      "/robots.txt": { headers: { "content-type": "text/plain" }, body: "User-agent: *\nAllow: /\n" },
    },
    "other.fixture.test": {
      "/landing": html("landing"),
      "/robots.txt": { headers: { "content-type": "text/plain" }, body: "User-agent: *\nAllow: /\n" },
    },
    "www-a.fixture.test": {
      "/": redirect(loc("www-b.fixture.test", "/"), 301),
      "/robots.txt": { headers: { "content-type": "text/plain" }, body: "User-agent: *\nAllow: /\n" },
    },
    "www-b.fixture.test": {
      "/": html("must never be read"),
      "/robots.txt": { headers: { "content-type": "text/plain" }, body: "User-agent: RetrofitBot\nDisallow: /\n" },
    },
  } satisfies FixtureRoutes);
});

afterAll(async () => {
  await server.close();
});

beforeEach(() => {
  paced = [];
  server.requests.length = 0;
});

describe("guardedFetch success path", () => {
  // Fails if the body, status, final URL or header allow-list changes (set-cookie and other headers must be dropped).
  it("returns the body and only the three kept headers", async () => {
    const res = await guardedFetch(u("site.fixture.test"), context());
    expect(res.status).toBe(200);
    expect(res.url).toBe(server.url("site.fixture.test", "/"));
    expect(res.body).toBe("<h1>Home</h1>");
    expect(res.truncated).toBe(false);
    expect(res.redirects).toEqual([]);
    expect(Object.keys(res.headers).sort()).toEqual(["content-type", "x-robots-tag"]);
    expect(res.headers["x-robots-tag"]).toBe("noarchive");
  });

  // Fails if non-text content types are read into memory instead of returning metadata only.
  it("returns metadata only for a non-text content type", async () => {
    const res = await guardedFetch(u("site.fixture.test", "/image"), context());
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
    expect(res.body).toBeNull();
  });

  // Fails if JSON stops counting as a readable content type.
  it("reads JSON bodies", async () => {
    const res = await guardedFetch(u("site.fixture.test", "/json"), context());
    expect(res.body).toBe('{"a":1}');
  });

  // Fails if the RetrofitBot user agent changes, if cookies are replayed across a redirect, or if compression is requested.
  it("sends the RetrofitBot user agent, no cookies and identity encoding", async () => {
    const res = await guardedFetch(u("site.fixture.test", "/cookie-hop"), context());
    const echo = JSON.parse(res.body ?? "{}") as { cookie: string | null; ua: string; enc: string };
    expect(echo.cookie).toBeNull();
    expect(echo.ua).toBe("RetrofitBot/0.1 (+https://retrofit.example/bot)");
    expect(echo.enc).toBe("identity");
    expect(res.redirects).toEqual([server.url("site.fixture.test", "/echo")]);
  });

  // Fails if pacing is skipped for robots.txt, the page or any redirect hop.
  it("paces every request, including robots.txt and each redirect hop", async () => {
    await guardedFetch(u("site.fixture.test", "/cross"), context());
    const site = new URL(server.url("site.fixture.test")).host;
    const other = new URL(server.url("other.fixture.test")).host;
    // robots(site), /cross, robots(other), /landing
    expect(paced).toEqual([site, site, other, other]);
    expect(server.requests.map((r) => `${r.host}${r.path}`)).toEqual([
      "site.fixture.test/robots.txt",
      "site.fixture.test/cross",
      "other.fixture.test/robots.txt",
      "other.fixture.test/landing",
    ]);
  });
});

describe("guardedFetch refusals", () => {
  // Each fails if a redirect target is followed without re-running validateUrl and the address guard.
  it.each(["/to-metadata", "/to-private-literal", "/to-fixture-private"])("refuses a redirect from %s to a blocked address", async (path) => {
    await expect(guardedFetch(u("site.fixture.test", path), context())).rejects.toBeInstanceOf(NotPublicError);
  });

  // Fails if a redirect to a DNS name is followed without resolving and checking its addresses.
  it("refuses a redirect to a name that resolves to a private address", async () => {
    const lookup: Resolver = async (h) => {
      if (h === "internal.example.com") return [{ address: "10.1.2.3", family: 4 }];
      return noRealDns(h);
    };
    await expect(guardedFetch(u("site.fixture.test", "/to-private-name"), context({ lookup }))).rejects.toBeInstanceOf(NotPublicError);
  });

  // Fails if the connect-time lookup trusts the earlier check (DNS rebinding: public at check time, private at connect time).
  it("refuses a rebinding resolver", async () => {
    let calls = 0;
    const lookup: Resolver = async (h) => {
      if (h !== "rebind.example.com") return noRealDns(h);
      calls += 1;
      // The first answer is loopback (allowed only in fixtures mode), so a regression cannot reach a real host.
      return [{ address: calls === 1 ? "127.0.0.1" : "169.254.169.254", family: 4 }];
    };
    await expect(rawGuardedGet(validateUrl("http://rebind.example.com/", config), context({ lookup }))).rejects.toBeInstanceOf(NotPublicError);
    expect(calls).toBe(2);
  });

  // Fails if the body limit is removed: a 5 MB page must stop at FETCH_MAX_BYTES and be flagged.
  it("truncates a 5 MB body at FETCH_MAX_BYTES", async () => {
    const res = await guardedFetch(u("site.fixture.test", "/big"), context());
    expect(res.truncated).toBe(true);
    expect(res.body?.length).toBe(config.fetchMaxBytes);
  });

  // Fails if FETCH_TIMEOUT_MS does not bound the wait for response headers.
  it("times out when the server never answers", async () => {
    const started = Date.now();
    await expect(guardedFetch(u("site.fixture.test", "/hang"), context())).rejects.toBeInstanceOf(FetchTimeoutError);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  // Fails if FETCH_TIMEOUT_MS does not bound the body stream.
  it("times out when the body never ends", async () => {
    await expect(guardedFetch(u("site.fixture.test", "/slow-body"), context())).rejects.toBeInstanceOf(FetchTimeoutError);
  });

  // Fails if the hop limit changes: five redirects are followed, the sixth is refused.
  it("follows five redirects", async () => {
    const ok = await guardedFetch(u("site.fixture.test", "/chain2"), context());
    expect(ok.redirects).toHaveLength(5);
    expect(ok.body).toBe("done");
  });

  // Fails if a sixth redirect is followed instead of refused.
  it("refuses the sixth redirect without requesting its target", async () => {
    const err = await guardedFetch(u("site.fixture.test", "/chain1"), context()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TooManyRedirects);
    expect((err as TooManyRedirects).code).toBe("too_many_redirects");
    expect(server.requests.some((r) => r.path === "/done")).toBe(false);
  });

  // Fails if redirect hops skip the robots check of the new host.
  it("stops with RobotsBlocked when a redirect lands on a robots-disallowed host", async () => {
    const err = await guardedFetch(u("www-a.fixture.test"), context()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RobotsBlocked);
    expect((err as RobotsBlocked).host).toBe(new URL(server.url("www-b.fixture.test")).host);
    expect(server.requests.some((r) => r.host === "www-b.fixture.test" && r.path === "/")).toBe(false);
  });
});

describe("deadline through the production fetch context (validation V07)", () => {
  // Fails if a pacing slot whose reservation returns after notAfter still lets guardedFetch contact the
  // site (robots.txt or the page): no request may start after the crawl deadline.
  it("sends no request when the pacing reservation returns after notAfter", async () => {
    let t = Date.parse("2026-11-15T10:20:00.000Z");
    const store = createMemoryStore({ clock: () => t });
    const slow: Store = {
      ...store,
      putIfAbsent: (async (key: string, value: unknown, ttl: number) => {
        if (key.startsWith("nextAllowedAt:")) t += 2000;
        return store.putIfAbsent(key, value, ttl);
      }) as Store["putIfAbsent"],
    };
    const ctx = createFetchContext({ config, store: slow, clock: () => t, lookup: noRealDns });
    const err = await guardedFetch(u("site.fixture.test"), ctx, { notAfter: t + 1000 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CrawlDelayTooLong);
    expect(server.requests.filter((r) => r.host === "site.fixture.test")).toEqual([]);
  });
});
