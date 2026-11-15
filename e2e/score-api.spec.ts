import { test, expect } from "./fixtures/csp";
import { fixtureOrigin } from "./support/global-setup";

// Through the real server, so headers added by the request hook are visible (a handler test cannot see them).
test("GET /api/score sends the contract headers through the real server", async ({ request }) => {
  const res = await request.get(`/api/score?url=${encodeURIComponent(fixtureOrigin("blocked.fixture.test"))}`);
  expect(res.status()).toBe(422);
  const h = res.headers();
  expect(h["cache-control"]).toBe("no-store");
  expect(h["access-control-allow-origin"]).toBe("*");
  expect(h["set-cookie"]).toBeUndefined();
  expect(h["content-type"]).toContain("application/json");
  const body = await res.json();
  expect(body.error).toBe("robots_blocked");
  expect(JSON.stringify(body)).not.toMatch(/\/r\/|\/p\/|[0-9a-f]{32}/);
});
