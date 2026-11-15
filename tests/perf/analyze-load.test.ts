import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bakery } from "../fixtures/sites";
import { serveSites } from "../helpers/sites";
import { PERF_ORIGIN } from "./global-setup";

type Server = Awaited<ReturnType<typeof serveSites>>;
let server: Server;

beforeAll(async () => {
  const sites: Record<string, typeof bakery> = {};
  for (let i = 1; i <= 10; i++) sites[`site${i}.fixture.test`] = bakery;
  server = await serveSites(() => sites);
});
afterAll(async () => {
  await server?.close();
});

async function analyze(url: string, cookie?: string): Promise<{ id: string; cookie: string }> {
  const res = await fetch(`${PERF_ORIGIN}/api/analyze`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: PERF_ORIGIN, ...(cookie ? { cookie } : {}) },
    body: JSON.stringify({ url }),
  });
  expect(res.status, await res.clone().text()).toBe(200);
  const setCookie = res.headers.get("set-cookie");
  return { id: ((await res.json()) as { id: string }).id, cookie: cookie ?? setCookie!.split(";")[0]! };
}

const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.ceil(xs.length * 0.95) - 1]!;

describe("analyze load (perf project, against next start on 3014)", () => {
  it("10 concurrent analyses and 20 viewers stay within the status budgets", async () => {
    const started = await Promise.all(Array.from({ length: 10 }, (_, i) => analyze(server.origin(`site${i + 1}.fixture.test`))));
    const watched = started[0]!;
    const latencies: number[] = [];
    const reads: number[] = [];
    let ready = false;
    const deadline = Date.now() + 90_000;
    while (!ready && Date.now() < deadline) {
      const round = await Promise.all(
        Array.from({ length: 20 }, async () => {
          const t = performance.now();
          const res = await fetch(`${PERF_ORIGIN}/api/analyze/${watched.id}`, { headers: { cookie: watched.cookie } });
          latencies.push(performance.now() - t);
          reads.push(Number(res.headers.get("x-retrofit-store-reads")));
          const body = (await res.json()) as { status: string };
          expect(JSON.stringify(body).length).toBeLessThanOrEqual(2048);
          return body.status;
        }),
      );
      ready = round.every((s) => s === "ready");
      if (!ready) await new Promise((r) => setTimeout(r, 1000));
    }
    expect(ready).toBe(true);
    // Fails if the shared host is crawled more than once.
    const homeFetches = server.requests.filter((r) => r.host === "site1.fixture.test" && r.path === "/");
    expect(homeFetches).toHaveLength(1);
    // Fails if a status request reads more than the analysis and its job.
    expect(Math.max(...reads)).toBeLessThanOrEqual(2);
    const budget = p95(latencies);
    console.log(`perf: ${latencies.length} status requests, p95 ${budget.toFixed(1)} ms, max store reads ${Math.max(...reads)}`);
    expect(budget).toBeLessThan(250);
    // Every analysis finishes.
    for (const a of started.slice(1)) {
      const deadline2 = Date.now() + 60_000;
      let status = "";
      while (status !== "ready" && Date.now() < deadline2) {
        status = ((await (await fetch(`${PERF_ORIGIN}/api/analyze/${a.id}`, { headers: { cookie: a.cookie } })).json()) as { status: string }).status;
        if (status !== "ready") await new Promise((r) => setTimeout(r, 500));
      }
      expect(status).toBe("ready");
    }
  });
});
