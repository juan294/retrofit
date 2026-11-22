import { expect, it } from "vitest";
import { bakery } from "../fixtures/sites";
import { serveSites } from "../helpers/sites";
import { PERF_ORIGIN } from "./global-setup";

it("serves 20 complete owner downloads below the size and p95 budgets", async () => {
  const host = "bundle-perf.fixture.test";
  const site = await serveSites(() => ({ [host]: bakery }));
  try {
    const start = await fetch(PERF_ORIGIN + "/api/analyze", {
      method: "POST",
      headers: { origin: PERF_ORIGIN, "content-type": "application/json", "x-real-ip": "198.51.100.211" },
      body: JSON.stringify({ url: site.origin(host) }),
    });
    expect(start.status).toBe(200);
    const { id } = await start.json();
    const headers = { cookie: start.headers.get("set-cookie")!.split(";")[0]! };
    await expect.poll(async () => {
      const status = await fetch(`${PERF_ORIGIN}/api/analyze/${id}`, { headers });
      return (await status.json()).status;
    }, { timeout: 30_000, interval: 250 }).toBe("ready");
    const times = [];
    let bytes = 0;
    for (let request = 0; request < 20; request++) {
      const begin = performance.now();
      const response = await fetch(`${PERF_ORIGIN}/p/${id}/bundle.zip`, { headers });
      bytes = (await response.arrayBuffer()).byteLength;
      times.push(performance.now() - begin);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/zip");
      expect(bytes).toBeLessThan(2_000_000);
    }
    const p95 = times.sort((a, b) => a - b)[18]!;
    console.log(`bundle: 20 downloads, p95 ${p95.toFixed(1)} ms, ${bytes} bytes`);
    expect(p95).toBeLessThan(500);
  } finally {
    await site.close();
  }
});
