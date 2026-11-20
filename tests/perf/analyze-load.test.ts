import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FixtureHandler, FixtureRoutes } from "../helpers/fixture-server";
import { isComplete, parseStatusSample, type StatusSample } from "../helpers/perf-oracle";
import { bakery, convergeTo } from "../fixtures/sites";
import { serveSites } from "../helpers/sites";
import { PERF_ORIGIN } from "./global-setup";

type Server = Awaited<ReturnType<typeof serveSites>>;
let server: Server;

/** Hosts whose home page answers only after SLOW_HOME_MS, so their crawls hold every slot for a while. */
const SLOW_HOSTS = Array.from({ length: 9 }, (_, i) => `slow${i + 1}.fixture.test`);
// Below FETCH_TIMEOUT_MS (8 s), so the home page still arrives.
const SLOW_HOME_MS = 4000;

beforeAll(async () => {
  const sites: Record<string, typeof bakery> = {};
  for (let i = 1; i <= 10; i++) sites[`site${i}.fixture.test`] = bakery;
  for (const h of SLOW_HOSTS) sites[h] = bakery;
  const slowHome: FixtureHandler = async (_req, res) => {
    await new Promise((r) => setTimeout(r, SLOW_HOME_MS));
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end("<main><h1>Slow bakery</h1></main>");
  };
  const extraRoutes: FixtureRoutes = Object.fromEntries(SLOW_HOSTS.map((h) => [h, { "/": slowHome }]));
  // A second input host that redirects to site1, so its job joins site1's crawl.
  server = await serveSites((o) => ({ ...sites, "alias1.fixture.test": convergeTo(o("site1.fixture.test")) }), { extraRoutes });
});
afterAll(async () => {
  await server?.close();
});

interface Visitor {
  id: string;
  cookie: string;
}

async function analyze(url: string, ip: string): Promise<Visitor> {
  const res = await fetch(`${PERF_ORIGIN}/api/analyze`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: PERF_ORIGIN, "x-real-ip": ip },
    body: JSON.stringify({ url }),
  });
  expect(res.status, await res.clone().text()).toBe(200);
  const setCookie = res.headers.get("set-cookie");
  return { id: ((await res.json()) as { id: string }).id, cookie: setCookie!.split(";")[0]! };
}

interface Timed {
  sample: StatusSample;
  ms: number;
}

/** One status request, checked by the oracle (tests/helpers/perf-oracle.ts): it throws instead of reading missing telemetry as zero. */
async function poll(v: Visitor): Promise<Timed> {
  const t = performance.now();
  const res = await fetch(`${PERF_ORIGIN}/api/analyze/${v.id}`, { headers: { cookie: v.cookie } });
  const ms = performance.now() - t;
  const text = await res.text();
  expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(2048);
  return { sample: parseStatusSample(res.status, res.headers, JSON.parse(text)), ms };
}

async function waitAllComplete(visitors: Visitor[], timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (const v of visitors) {
    let done = false;
    while (!done && Date.now() < deadline) {
      done = isComplete((await poll(v)).sample);
      if (!done) await new Promise((r) => setTimeout(r, 500));
    }
    expect(done, `analysis ${v.id} completes`).toBe(true);
  }
}

/** Every dispatch claims once per started job, plus the one claim that found nothing to start. */
function expectOneClaimPerRound(samples: StatusSample[]): void {
  for (const s of samples) expect(s.dispatch.claims).toBe(s.dispatch.started + 1);
}

const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.ceil(xs.length * 0.95) - 1]!;

describe("analyze load (perf project, against next start on 3014)", () => {
  it("10 concurrent analyses and 20 viewers stay within the status budgets", async () => {
    const started = await Promise.all(Array.from({ length: 10 }, (_, i) => analyze(server.origin(`site${i + 1}.fixture.test`), `198.51.100.${i + 1}`)));
    const watched = started[0]!;
    // A second visitor whose analysis converges on site1 through a redirect (join path).
    const joiner = await analyze(server.origin("alias1.fixture.test"), "198.51.100.50");
    const timed: Timed[] = [];
    let ready = false;
    const deadline = Date.now() + 90_000;
    while (!ready && Date.now() < deadline) {
      // 15 viewers watch the first visitor's analysis, 5 watch the joiner's.
      const round = await Promise.all(Array.from({ length: 20 }, (_, i) => poll(i < 15 ? watched : joiner)));
      timed.push(...round);
      // Complete means ready with a readable score; ready without one fails the oracle.
      ready = round.every((r) => isComplete(r.sample));
      if (!ready) await new Promise((r) => setTimeout(r, 1000));
    }
    expect(ready).toBe(true);
    // Fails if the shared host is crawled more than once. The joiner's worker fetches site1's
    // home page once through the redirect to learn the destination, then joins; linked pages are read once.
    const menuFetches = server.requests.filter((r) => r.host === "site1.fixture.test" && r.path === "/menu");
    expect(menuFetches).toHaveLength(1);
    const samples = timed.map((t) => t.sample);
    // Fails if a status request (including the first read after a join) reads more than two records,
    // or makes more than one write (the copy of the result) on top of them.
    expect(Math.max(...samples.map((s) => s.reads))).toBeLessThanOrEqual(2);
    expect(Math.max(...samples.map((s) => s.foregroundOps))).toBeLessThanOrEqual(3);
    // Fails if dispatch costs more than one store operation per round (V16: one lease attempt per slot).
    expectOneClaimPerRound(samples);
    for (const s of samples.filter((x) => x.dispatch.started === 0)) expect(s.dispatch.operations).toBe(1);
    const budget = p95(timed.map((t) => t.ms));
    const total = samples.map((s) => s.foregroundOps + s.dispatch.operations);
    console.log(
      `perf: ${timed.length} status requests, p95 ${budget.toFixed(1)} ms (including the dispatch each starts), max reads ${Math.max(...samples.map((s) => s.reads))}, max foreground ops ${Math.max(...samples.map((s) => s.foregroundOps))}, max foreground+dispatch ops ${Math.max(...total)}, dispatches that started a job ${samples.filter((s) => s.dispatch.started > 0).length}`,
    );
    expect(budget).toBeLessThan(250);
    // Every analysis finishes.
    await waitAllComplete(started.slice(1), 60_000);
  });

  // V16. Fails if a status poll at full capacity or with an empty queue makes more than one dispatch
  // store operation (the old dispatch made one lease attempt per slot, or acquire, claim and release).
  it("measures total store work per poll with every slot occupied and with an empty queue", async () => {
    const visitors = await Promise.all(SLOW_HOSTS.map((h, i) => analyze(server.origin(h), `198.51.100.${100 + i}`)));
    // Wait until eight crawls hold the eight slots and the ninth job is queued.
    const deadline = Date.now() + 5000;
    let statuses: string[] = [];
    while (Date.now() < deadline) {
      statuses = (await Promise.all(visitors.map(poll))).map((t) => t.sample.status);
      if (statuses.filter((s) => s === "crawling").length === 8 && statuses.includes("queued")) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(statuses.filter((s) => s === "crawling")).toHaveLength(8);
    const queued = visitors[statuses.indexOf("queued")]!;

    // 20 simultaneous polls at full capacity with a job waiting.
    const occupied = (await Promise.all(Array.from({ length: 20 }, (_, i) => poll(visitors[i % visitors.length]!)))).map((t) => t.sample);
    expect(occupied.find((_, i) => visitors[i % visitors.length] === queued)?.status).toBe("queued");
    for (const s of occupied) expect(s.dispatch).toEqual({ started: 0, operations: 1, claims: 1 });

    await waitAllComplete(visitors, 90_000);
    // 20 simultaneous polls of finished analyses: the queue is empty and every slot is free.
    const empty = (await Promise.all(Array.from({ length: 20 }, (_, i) => poll(visitors[i % visitors.length]!)))).map((t) => t.sample);
    for (const s of empty) {
      expect(s.dispatch).toEqual({ started: 0, operations: 1, claims: 1 });
      // The analysis holds its copied result: one read, no job read, no write.
      expect(s.reads).toBe(1);
      expect(s.foregroundOps).toBe(1);
    }
    const perPoll = (xs: StatusSample[]) => Math.max(...xs.map((s) => s.foregroundOps + s.dispatch.operations));
    console.log(`perf: store operations per poll (foreground + dispatch), max: occupied slots ${perPoll(occupied)}, empty queue ${perPoll(empty)}`);
  }, 120_000);
});
