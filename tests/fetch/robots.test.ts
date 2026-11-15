import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, type Config } from "@/lib/config";
import { NotPublicError, RobotsBlocked, RobotsUnavailable } from "@/lib/fetch/errors";
import type { Resolver } from "@/lib/fetch/guard";
import { guardedFetch } from "@/lib/fetch/http";
import { createRobots } from "@/lib/fetch/robots";
import { validateUrl } from "@/lib/fetch/url";
import { createMemoryBacking, createMemoryStore } from "@/lib/store/memory";
import type { Store } from "@/lib/store/types";
import { startFixtureServer, type FixtureRoutes, type FixtureServer } from "../helpers/fixture-server";

const config: Config = loadConfig({ RETROFIT_TEST_FIXTURES: "1", SESSION_SECRET: "x".repeat(32), FETCH_TIMEOUT_MS: "300" });
const HOUR_MS = 3600 * 1000;

const routes: FixtureRoutes = {};
let server: FixtureServer;
let now: number;
let paced: Array<[string, number | undefined]>;
let robotsStatus: number;

const clock = () => now;
const pace = async (host: string, delay?: number) => {
  paced.push([host, delay]);
};
const noRealDns: Resolver = async (hostname) => {
  throw Object.assign(new Error(`test resolver: ${hostname} is not stubbed`), { code: "ENOTFOUND" });
};
const text = (body: string) => ({ headers: { "content-type": "text/plain" }, body });
const page = { headers: { "content-type": "text/html" }, body: "<p>ok</p>" };

function robotsFor(store: Store, lookup: Resolver = noRealDns) {
  return createRobots({ config, store, pace, lookup, clock });
}
const u = (host: string, path = "/") => validateUrl(server.url(host, path), config);
const hostOf = (host: string) => new URL(server.url(host)).host;
const robotsHits = (host: string) => server.requests.filter((r) => r.host === host && r.path === "/robots.txt").length;

beforeAll(async () => {
  server = await startFixtureServer(routes);
  Object.assign(routes, {
    "deny.fixture.test": { "/robots.txt": text("User-agent: RetrofitBot\nDisallow: /\n"), "/": page },
    "partial.fixture.test": { "/robots.txt": text("User-agent: *\nDisallow: /private\n"), "/": page },
    "otherbot.fixture.test": { "/robots.txt": text("User-agent: OtherBot\nDisallow: /\n"), "/": page },
    "allow.fixture.test": { "/robots.txt": text("User-agent: *\nAllow: /\n"), "/": page },
    "missing.fixture.test": { "/": page },
    "flaky.fixture.test": {
      "/robots.txt": (_req, res) => {
        res.writeHead(robotsStatus, { "content-type": "text/plain" }).end(robotsStatus === 200 ? "User-agent: *\nAllow: /\n" : "error");
      },
      "/": page,
    },
    "slow.fixture.test": { "/robots.txt": () => {} },
    "delay.fixture.test": { "/robots.txt": text("User-agent: RetrofitBot\nCrawl-delay: 5\nAllow: /\n"), "/": page },
    "www-a.fixture.test": { "/robots.txt": text("User-agent: *\nAllow: /\n"), "/": { status: 301, headers: { location: "" } } },
    "www-b.fixture.test": { "/robots.txt": text("User-agent: RetrofitBot\nDisallow: /\n"), "/": page },
  } satisfies FixtureRoutes);
  routes["www-a.fixture.test"]!["/"] = { status: 301, headers: { location: server.url("www-b.fixture.test", "/") } };
});

afterAll(async () => {
  await server.close();
});

beforeEach(() => {
  now = Date.parse("2026-11-15T10:00:00Z");
  paced = [];
  robotsStatus = 500;
  server.requests.length = 0;
});

describe("robots check", () => {
  // Fails if a RetrofitBot disallow is ignored or the error loses its host and code.
  it("refuses a host whose robots.txt disallows RetrofitBot", async () => {
    const err = await robotsFor(createMemoryStore({ clock })).check(u("deny.fixture.test")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RobotsBlocked);
    expect((err as RobotsBlocked).host).toBe(hostOf("deny.fixture.test"));
    expect((err as RobotsBlocked).code).toBe("robots_blocked");
  });

  // Fails if rules are applied to the whole host instead of per path.
  it("applies path rules", async () => {
    const robots = robotsFor(createMemoryStore({ clock }));
    await expect(robots.check(u("partial.fixture.test", "/menu"))).resolves.toBeUndefined();
    await expect(robots.check(u("partial.fixture.test", "/private/x"))).rejects.toBeInstanceOf(RobotsBlocked);
  });

  // Fails if the user agent is not RetrofitBot (a group for another bot must not apply).
  it("allows when only another bot is disallowed", async () => {
    await expect(robotsFor(createMemoryStore({ clock })).check(u("otherbot.fixture.test"))).resolves.toBeUndefined();
  });

  // Fails if an explicit allow is treated as a refusal.
  it("allows an allowed host", async () => {
    await expect(robotsFor(createMemoryStore({ clock })).check(u("allow.fixture.test"))).resolves.toBeUndefined();
  });

  // Fails if a 404 robots.txt stops meaning "no rules".
  it("allows when robots.txt is 404", async () => {
    await expect(robotsFor(createMemoryStore({ clock })).check(u("missing.fixture.test"))).resolves.toBeUndefined();
  });

  // Fails if a 5xx is treated as allow, or retryAt is not now + 1 hour.
  it("gives RobotsUnavailable with retryAt one hour ahead on a 500", async () => {
    const err = await robotsFor(createMemoryStore({ clock })).check(u("flaky.fixture.test")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RobotsUnavailable);
    expect((err as RobotsUnavailable).code).toBe("robots_unavailable");
    expect((err as RobotsUnavailable).host).toBe(hostOf("flaky.fixture.test"));
    expect((err as RobotsUnavailable).retryAt.getTime()).toBe(now + HOUR_MS);
  });

  // Fails if a robots.txt timeout is treated as allow.
  it("gives RobotsUnavailable when robots.txt times out", async () => {
    const err = await robotsFor(createMemoryStore({ clock })).check(u("slow.fixture.test")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RobotsUnavailable);
    expect((err as RobotsUnavailable).retryAt.getTime()).toBe(now + HOUR_MS);
  });

  // Fails if the unavailable state is not cached for one hour, or never expires.
  it("caches the unavailable state for one hour, then retries", async () => {
    const robots = robotsFor(createMemoryStore({ clock }));
    await expect(robots.check(u("flaky.fixture.test"))).rejects.toBeInstanceOf(RobotsUnavailable);
    robotsStatus = 200;
    now += HOUR_MS - 1000;
    const err = await robots.check(u("flaky.fixture.test")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RobotsUnavailable);
    expect((err as RobotsUnavailable).retryAt.getTime()).toBe(Date.parse("2026-11-15T11:00:00Z"));
    expect(robotsHits("flaky.fixture.test")).toBe(1);
    now += 2000;
    await expect(robots.check(u("flaky.fixture.test"))).resolves.toBeUndefined();
    expect(robotsHits("flaky.fixture.test")).toBe(2);
  });

  // Fails if the cache is per process instead of in the Store (two server instances must share it), or has no TTL.
  it("shares the cache between two clients through the store for one hour", async () => {
    const backing = createMemoryBacking();
    const a = robotsFor(createMemoryStore({ clock, backing }));
    const b = robotsFor(createMemoryStore({ clock, backing }));
    await a.check(u("allow.fixture.test"));
    await b.check(u("allow.fixture.test", "/other"));
    expect(robotsHits("allow.fixture.test")).toBe(1);
    now += HOUR_MS + 1000;
    await b.check(u("allow.fixture.test"));
    expect(robotsHits("allow.fixture.test")).toBe(2);
  });

  // Fails if the robots.txt request skips pacing.
  it("paces the robots.txt request", async () => {
    await robotsFor(createMemoryStore({ clock })).check(u("allow.fixture.test"));
    expect(paced.map(([h]) => h)).toEqual([hostOf("allow.fixture.test")]);
  });

  // Fails if the robots.txt request bypasses the address guard.
  it("fetches robots.txt through the address guard", async () => {
    const lookup: Resolver = async (h) => (h === "evil.example.com" ? [{ address: "10.0.0.9", family: 4 }] : noRealDns(h));
    const robots = robotsFor(createMemoryStore({ clock }), lookup);
    await expect(robots.check(validateUrl("http://evil.example.com/", config))).rejects.toBeInstanceOf(NotPublicError);
  });
});

describe("crawl delay", () => {
  // Fails if Crawl-delay for RetrofitBot is not read, or not passed to pacing for page requests.
  it("exposes the crawl delay and passes it to pacing", async () => {
    const store = createMemoryStore({ clock });
    const robots = robotsFor(store);
    await guardedFetch(u("delay.fixture.test"), { config, store, robots, pace, lookup: noRealDns });
    await expect(robots.crawlDelay(hostOf("delay.fixture.test"))).resolves.toBe(5);
    expect(paced).toEqual([
      [hostOf("delay.fixture.test"), undefined],
      [hostOf("delay.fixture.test"), 5],
    ]);
  });

  // Fails if crawlDelay invents a value for a host without one.
  it("is undefined when robots.txt sets none", async () => {
    const robots = robotsFor(createMemoryStore({ clock }));
    await robots.check(u("allow.fixture.test"));
    await expect(robots.crawlDelay(hostOf("allow.fixture.test"))).resolves.toBeUndefined();
  });
});

describe("redirect-www", () => {
  // Fails if robots is checked only on the first host of a redirect chain.
  it("stops on the second host and reads nothing from it", async () => {
    const store = createMemoryStore({ clock });
    const err = await guardedFetch(u("www-a.fixture.test"), { config, store, robots: robotsFor(store), pace, lookup: noRealDns }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(RobotsBlocked);
    expect((err as RobotsBlocked).host).toBe(hostOf("www-b.fixture.test"));
    expect(server.requests.map((r) => `${r.host}${r.path}`)).toEqual([
      "www-a.fixture.test/robots.txt",
      "www-a.fixture.test/",
      "www-b.fixture.test/robots.txt",
    ]);
  });
});
