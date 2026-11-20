// Hostile model output and hostile tool results reach every renderer path that model, tool or
// site-content data can reach in a preview (research 2026-11-15-phase-4-entry.md §5). The audit
// found no such path that relies on CSP, so every case expects zero CSP violations (the
// fixture default). Paths fed only by peers, the generator or constants (consent card, linker
// form, network tree, header, settings, action review) are not reachable from a preview.
import { test, expect } from "./fixtures/csp";
import { OTARI, analyzeFixture, connectKey, mockOtari } from "./support/agent";
import type { MockRouter } from "./support/mock-router";
import { RETROFIT_ORIGIN, recordRequests, type BrowserContext, type Page, type RequestLog } from "./support/extra-requests";
import { ALL, CSS, CSS_URL, IMG, JS_LINK, RAW_JS_LINK, SCRIPT, THIRD, expectInert, hostileScript, injectHostileContent } from "./support/extra-hostile";

const ALLOWED = [RETROFIT_ORIGIN, new URL(OTARI.routerBase).origin];
const QUESTION = "Tell me about your candles";

const MARKDOWN = [
  "Here is what the snapshot says.",
  "",
  IMG,
  "",
  SCRIPT,
  "",
  `See ${JS_LINK} and ${RAW_JS_LINK}.`,
  "",
  CSS,
  "",
  `- item ${IMG}`,
  `## ${SCRIPT}`,
  `| ${IMG} | b |`,
  "| --- | --- |",
  `| ${JS_LINK} | ${CSS_URL} |`,
].join("\n");

const fence = (components: unknown[]) => `Here is a summary.\n\n\`\`\`cruse-ui\n${JSON.stringify({ version: 1, components })}\n\`\`\``;

interface Session {
  page: Page;
  log: RequestLog;
  router: MockRouter;
  mount: ReturnType<Page["getByTestId"]>;
}

async function hostileSession(page: Page, context: BrowserContext, finalAnswer: string, o: { dev?: boolean } = {}): Promise<Session> {
  const log = recordRequests(context);
  if (o.dev) await page.addInitScript(() => localStorage.setItem("nsweb-dev", "1"));
  const router = await mockOtari(page, hostileScript(finalAnswer));
  const injected = await injectHostileContent(page);
  await analyzeFixture(page, "hostile.fixture.test");
  await connectKey(page);
  const mount = page.getByTestId("preview-mount");
  await expect(mount.locator('[data-ns-slot="chat"]')).toBeVisible();
  // boot loaded content-actions.js, which read the injected site-content.json.
  await expect.poll(() => injected.served).toBeGreaterThanOrEqual(1);
  const input = mount.getByRole("textbox").last();
  await input.fill(QUESTION);
  await input.press("Enter");
  await expect(mount.locator(".ns-msg.user")).toHaveCount(1);
  await expect.poll(() => router.bodies.length, { timeout: 20_000 }).toBeGreaterThanOrEqual(1);
  return { page, log, router, mount };
}

/** The content tools ran and their results, carrying every payload, reached the model. */
function expectToolResultsCarriedPayloads(router: MockRouter) {
  const toolMessages = router.bodies.flatMap((b) => b.messages.filter((m) => m.role === "tool").map((m) => m.content ?? ""));
  const plain = toolMessages.map((t) => t.replace(/\\+"/g, '"').replace(/\\u003c/gi, "<").replace(/\\u003e/gi, ">"));
  expect(plain.some((t) => t.includes("onerror=window.__pwned=1") && t.includes("<script>window.__pwned=1</script>") && t.includes("javascript:window.__pwned=1") && t.includes(CSS_URL)), "a content tool result with every payload").toBe(true);
}

async function finished(s: Session) {
  // The front agent's final model call happened (delegation, two tools, two answers).
  await expect.poll(() => s.router.bodies.length, { timeout: 20_000 }).toBeGreaterThanOrEqual(4);
  await expect(s.mount.getByRole("textbox").last()).toBeEnabled({ timeout: 20_000 });
}

test("final answer bubble (renderMarkdown) shows the payloads as text", async ({ page, context }) => {
  const s = await hostileSession(page, context, MARKDOWN);
  await finished(s);
  const bubble = s.mount.locator(".ns-msg.bot").filter({ hasText: "Here is what the snapshot says." }).last();
  await expect(bubble).toBeVisible();
  await expect(bubble).toContainText(IMG);
  await expect(bubble).toContainText(SCRIPT);
  await expect(bubble).toContainText(RAW_JS_LINK);
  await expect(bubble).toContainText(CSS_URL);
  // The Markdown link with a javascript: target is a span, not a link.
  await expect(bubble.locator("span", { hasText: /^click$/ })).toHaveCount(2);
  await expect(bubble.locator("a")).toHaveCount(0);
  expectToolResultsCarriedPayloads(s.router);
  await expectInert(page, s.log, ALLOWED);
});

test("CRUSE widgets (form, choice, info, confirm) escape every model-supplied field", async ({ page, context }) => {
  const final = fence([
    {
      kind: "form",
      title: `Form ${IMG}`,
      description: SCRIPT,
      icon: IMG,
      color: CSS_URL,
      schema: {
        type: "object",
        properties: {
          name: { type: "string", title: IMG, description: SCRIPT, default: RAW_JS_LINK },
          kind: { type: "string", title: `Kind ${SCRIPT}`, enum: [IMG, SCRIPT, JS_LINK] },
          count: { type: "number", title: CSS, minimum: "1);background:url(x)" as unknown as number },
        },
        required: ["name"],
      },
    },
    { kind: "choice", title: `Choice ${IMG}`, color: `red;background:${CSS_URL}`, options: [{ label: IMG, value: SCRIPT, description: JS_LINK }, { label: RAW_JS_LINK, value: "b" }] },
    { kind: "info", title: `Info ${SCRIPT}`, fields: { [IMG]: SCRIPT, link: RAW_JS_LINK, css: CSS } },
    { kind: "confirm", title: `Confirm ${IMG}`, confirmText: SCRIPT, description: CSS },
  ]);
  const s = await hostileSession(page, context, final);
  await finished(s);
  const widgets = s.mount.locator(".ns-widget");
  await expect(widgets).toHaveCount(4);
  await expect(widgets.nth(0)).toContainText(`Form ${IMG}`);
  await expect(widgets.nth(1)).toContainText(`Choice ${IMG}`);
  await expect(widgets.nth(2)).toContainText(`Info ${SCRIPT}`);
  await expect(widgets.nth(3)).toContainText(`Confirm ${IMG}`);
  // spec.color with url() or extra CSS is refused, so no custom property is set.
  const colors = await widgets.evaluateAll((els) => els.map((el) => (el as HTMLElement).style.getPropertyValue("--w")));
  expect(colors.filter((c) => c.includes("url"))).toEqual([]);
  expectToolResultsCarriedPayloads(s.router);
  await expectInert(page, s.log, ALLOWED);
});

test("report, table and chart components render the payloads as text", async ({ page, context }) => {
  const final = fence([
    { kind: "report", title: `Report ${IMG}`, markdown: MARKDOWN },
    { kind: "table", title: `Table ${SCRIPT}`, columns: [IMG, SCRIPT], rows: [[JS_LINK, CSS], [RAW_JS_LINK, CSS_URL]] },
    { kind: "chart", title: `Chart ${IMG}`, chartType: "bar", summary: `Summary ${SCRIPT}`, labels: [IMG, RAW_JS_LINK], series: [{ name: CSS, values: [1, 2] }] },
  ]);
  const s = await hostileSession(page, context, final);
  await finished(s);
  const surface = s.mount.locator(".ns-presentation").last();
  await expect(surface).toBeVisible();
  await expect(surface).toContainText(`Report ${IMG}`);
  await expect(surface).toContainText("Here is what the snapshot says.");
  await expect(surface).toContainText(`Table ${SCRIPT}`);
  await expect(surface.locator("table").first()).toBeVisible();
  await expect(surface).toContainText(`Summary ${SCRIPT}`);
  await expect(surface).toContainText(CSS_URL);
  expectToolResultsCarriedPayloads(s.router);
  await expectInert(page, s.log, ALLOWED);
});

test("html component (renderSafeHtml) drops scripts, images, styles and javascript: links", async ({ page, context }) => {
  const html = [
    IMG,
    SCRIPT,
    RAW_JS_LINK,
    CSS,
    `<p onclick="window.__pwned=1" style="background:${CSS_URL}">paragraph kept</p>`,
    `<iframe src="${THIRD}/frame"></iframe>`,
    `<svg onload="window.__pwned=1"><image href="${THIRD}/x.png"/></svg>`,
    `<object data="${THIRD}/x.png"></object>`,
    `<link rel="stylesheet" href="${THIRD}/x.css">`,
    `<form action="javascript:window.__pwned=1"><button formaction="javascript:window.__pwned=1">go</button></form>`,
    `<details open><summary>summary kept</summary><a href="JaVaScRiPt:window.__pwned=1">mixed case</a></details>`,
    `<table><tr><td colspan="2" style="background:${CSS_URL}">cell kept</td></tr></table>`,
  ].join("");
  const s = await hostileSession(page, context, fence([{ kind: "html", title: `Html ${IMG}`, html }]));
  await finished(s);
  const surface = s.mount.locator(".ns-presentation").last();
  await expect(surface).toContainText(`Html ${IMG}`);
  await expect(surface).toContainText("paragraph kept");
  await expect(surface).toContainText("summary kept");
  await expect(surface).toContainText("cell kept");
  // The javascript: anchors lost their href; text inside dropped tags is gone.
  await expect(surface.locator("a[href]")).toHaveCount(0);
  // Only the escaped title still shows the payload text; the html body keeps none of it.
  const bodyText = (await surface.innerText()).replace(`Html ${IMG}`, "");
  expect(bodyText).not.toContain("window.__pwned");
  expect(bodyText).not.toContain("<");
  expectToolResultsCarriedPayloads(s.router);
  await expectInert(page, s.log, ALLOWED);
});

test("error bubble shows a hostile router error body as text", async ({ page, context }) => {
  // Registered after the mock router's own route, so it answers the chat request first.
  const body = `${ALL} ${MARKDOWN}`;
  let errors = 0;
  const log = recordRequests(context);
  await mockOtari(page, hostileScript(MARKDOWN));
  await page.route(`${OTARI.routerBase}/chat/completions`, async (route) => {
    if (route.request().method() === "OPTIONS") return route.fallback();
    errors++;
    return route.fulfill({ status: 500, headers: { "access-control-allow-origin": "*", "content-type": "text/html" }, body });
  });
  await analyzeFixture(page, "hostile.fixture.test");
  await connectKey(page);
  const mount = page.getByTestId("preview-mount");
  const input = mount.getByRole("textbox").last();
  await input.fill(QUESTION);
  await input.press("Enter");
  const bubble = mount.locator(".ns-msg.bot").filter({ hasText: "LLM HTTP 500" }).last();
  await expect(bubble).toBeVisible({ timeout: 20_000 });
  await expect(bubble).toContainText(IMG);
  await expect(bubble).toContainText(SCRIPT);
  expect(errors).toBeGreaterThanOrEqual(1);
  await expectInert(page, log, ALLOWED);
});

test("developer log escapes tool results, answer previews and request payloads", async ({ page, context }) => {
  const s = await hostileSession(page, context, MARKDOWN, { dev: true });
  await finished(s);
  // In the composed layout the runtime's app root (runtime/ui.js:413) is the per-boot root that
  // Preview.tsx puts inside the mount, so a late boot never takes over the live one.
  const root = s.mount.locator("[data-nsdeploy-ui]");
  await expect(root).toHaveCount(1);
  await expect(root).toHaveAttribute("data-dev", "true");
  const dev = s.mount.locator(".ns-dev");
  await expect(dev).toBeVisible();
  // Rows for the tool results exist; their previews are cut short by the runtime, and the
  // specialist's answer and the run input carry the payloads into the log as text.
  await expect(dev.locator(".ns-row.k-tool_result").first()).toBeAttached();
  const devText = await dev.evaluate((el) => el.textContent ?? "");
  expect(devText).toContain("onerror=window.__pwned=1");
  expect(devText).toContain("<script>window.__pwned=1</script>");
  // Open every collapsed detail so its escaped JSON is laid out too.
  await dev.locator(".ns-row pre").evaluateAll((pres) => pres.forEach((p) => ((p as HTMLElement).style.display = "block")));
  // The agent map's inspector shows request and reply previews for peers only
  // (runtime/ui.js:893-905); a preview has no peers, so it carries no model or tool text here.
  expectToolResultsCarriedPayloads(s.router);
  await expectInert(page, s.log, ALLOWED);
});
