// Published pages and badges in production, as far as they can be checked without an owner's account:
// a host nobody published answers 404 for its page, its agent files and its badge, none of it cached.
import { test, expect } from "./fixtures/csp";

const HOST = "not-published.example.com";

test("a host that is not published answers 404 for its page, its files and its badge", async ({ page, request, evidence }) => {
  evidence.case("published-unknown");
  const res = await page.goto(`/s/${HOST}`);
  expect(res?.status()).toBe(404);
  await expect(page.getByRole("heading", { level: 1, name: "No published agent here" })).toBeVisible();
  const paths = [`/s/${HOST}/agent-manifest.json`, `/s/${HOST}/content-actions.js`, `/s/${HOST}/bridge/action-bridge.html`, `/badge/${HOST}.svg`];
  for (const path of paths) {
    const answer = await request.get(path);
    expect(answer.status(), path).toBe(404);
    expect(answer.headers()["cache-control"], path).toMatch(/no-store/);
  }
  evidence.record({ paths: [`/s/${HOST}`, ...paths] });
});
