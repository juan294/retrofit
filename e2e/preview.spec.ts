import { test, expect } from "./fixtures/csp";
import { analyzeFixture, connectKey, mockOtari, traceEvents } from "./support/agent";
import { toolNames, type Script } from "./support/mock-router";

test("a visitor previews the bakery agent with their own key", async ({ page }) => {
  const router = await mockOtari(page);
  await analyzeFixture(page, "bakery.fixture.test");
  await expect(page.getByTestId("preview-label").first()).toContainText(
    /^Private preview\. Unofficial\. Built by Retrofit from public pages of bakery\.fixture\.test:3011 on \d{4}-\d{2}-\d{2}\. Not affiliated with bakery\.fixture\.test:3011\.$/,
  );
  await connectKey(page);
  const mount = page.getByTestId("preview-mount");
  await expect(mount.locator('[data-ns-slot="chat"]')).toBeVisible();

  // The runtime's own layout is styled (its BASE_CSS was inserted and applied).
  // BASE_CSS sets .ns-msgs{display:flex;flex-direction:column}; a browser default would be block.
  const direction = await mount.locator(".ns-msgs").first().evaluate((el) => getComputedStyle(el).flexDirection + " " + getComputedStyle(el).display);
  expect(direction).toBe("column flex");

  const input = mount.getByRole("textbox").last();
  await input.fill("What are your opening hours?");
  await input.press("Enter");
  // The answer quotes the snapshot: the hours and a source link.
  await expect(mount.getByText(/Our opening hours are Monday to Friday 7:00 to 18:00/).filter({ visible: true }).first()).toBeVisible({ timeout: 20_000 });
  await expect(mount.getByRole("link", { name: /bakery\.fixture\.test:3011/ }).filter({ visible: true }).first()).toBeVisible();
  await expect(page.getByTestId("preview-label")).toBeVisible();

  // The content tool ran, as the trace records (the visible status names it "Website Search Site Content").
  const tools = (await traceEvents(page)).filter((e) => e.kind === "tool").map((e) => e.tool);
  expect(tools).toContain("website_search_site_content");
  // One agent: it searches, then answers. Two model calls, and no delegation tool is offered.
  expect(router.bodies.length).toBe(2);
  expect(router.bodies.every((b) => !toolNames(b).includes("content_specialist"))).toBe(true);
});

/**
 * Worst case for a weak model: it calls a tool whenever one is offered and never answers.
 * It delegates whenever it can, and otherwise runs four searches on every step.
 */
const greedyScript: Script = (body) => {
  const tools = toolNames(body);
  if (tools.includes("content_specialist")) return { call: [{ name: "content_specialist", args: { request: "everything" } }] };
  if (tools.includes("website_search_site_content")) {
    return { call: ["hours", "menu", "prices", "contact"].map((query) => ({ name: "website_search_site_content", args: { query } })) };
  }
  return { text: "No tools." };
};

// Fails if a question can cost more model calls than the preview agent's step limit (site_guide, 4 steps).
test("a model that never stops calling tools costs at most 4 model calls per question", async ({ page }) => {
  const router = await mockOtari(page, greedyScript);
  await analyzeFixture(page, "bakery.fixture.test");
  await connectKey(page);
  const mount = page.getByTestId("preview-mount");
  await expect(mount.locator('[data-ns-slot="chat"]')).toBeVisible();
  const input = mount.getByRole("textbox").last();
  await input.fill("Tell me everything.");
  await input.press("Enter");
  // The turn is over when the router has seen no new request for 3 s.
  let seen = -1;
  await expect
    .poll(
      async () => {
        await page.waitForTimeout(3_000);
        const now = router.bodies.length;
        const settled = now === seen;
        seen = now;
        return settled;
      },
      { timeout: 60_000 },
    )
    .toBe(true);
  expect(router.bodies.length).toBeGreaterThan(0);
  expect(router.bodies.length).toBeLessThanOrEqual(4);
});
