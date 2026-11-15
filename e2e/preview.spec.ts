import { test, expect } from "./fixtures/csp";
import { analyzeFixture, connectKey, mockOtari } from "./support/agent";

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
  const tools = await page.evaluate(() => {
    const w = window as unknown as { __nsweb?: { trace: { events: { kind: string; tool?: string }[] } } };
    return (w.__nsweb?.trace.events ?? []).filter((e) => e.kind === "tool").map((e) => e.tool);
  });
  expect(tools).toContain("website_search_site_content");
  expect(router.bodies.length).toBeGreaterThanOrEqual(4);
});
