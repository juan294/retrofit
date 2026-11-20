import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { test, expect } from "./fixtures/csp";
import { analyzeFixture, connectKey, mockOtari } from "./support/agent";
import { normalizeCapture } from "./support/runtime-capture";

const OUT = "tests/fixtures/runtime-requests";

/**
 * Captures the exact request bodies the vendored runtime sends during a scripted session with
 * an agent delegation, a website_search_site_content result and the next model call. Phase 6
 * replays them through the free-path request schema. Each capture records the vendor manifest hash.
 */
test("captures the runtime's chat request bodies for the free-path schema", async ({ page }) => {
  const router = await mockOtari(page);
  await analyzeFixture(page, "bakery.fixture.test");
  await connectKey(page);
  const mount = page.getByTestId("preview-mount");
  const input = mount.getByRole("textbox").last();
  await input.fill("What are your opening hours?");
  await input.press("Enter");
  await expect(mount.getByText(/Our opening hours are/).filter({ visible: true }).first()).toBeVisible({ timeout: 20_000 });

  const bodies = router.bodies;
  // The session covers a delegation, a tool result with its name, and the model call after it.
  expect(bodies.some((b) => b.messages.some((m) => m.role === "assistant" && m.tool_calls?.some((c) => c.function.name === "content_specialist")))).toBe(true);
  expect(bodies.some((b) => b.messages.some((m) => m.role === "tool" && m.name === "website_search_site_content"))).toBe(true);

  const vendorHash = createHash("sha256").update(readFileSync("vendor/agentic-web.json")).digest("hex");
  mkdirSync(OUT, { recursive: true });
  // Dynamic values are normalized, so a rerun on the same runtime writes nothing.
  const capture = {
    vendorManifestSha256: vendorHash,
    note: "Request bodies sent by the vendored runtime to <router>/chat/completions. Synthetic bakery fixture; test key only. Ids, timestamps and the snapshot date normalized.",
    bodies: JSON.parse(normalizeCapture(JSON.stringify(bodies))) as unknown[],
  };
  const file = `${OUT}/bakery-session.json`;
  const text = `${JSON.stringify(capture, null, 2)}\n`;
  if (!existsSync(file) || readFileSync(file, "utf8") !== text) writeFileSync(file, text);
});
