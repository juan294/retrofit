import type { Page } from "@playwright/test";
import { expect } from "../fixtures/csp";
import { lastToolResult, toolNames, type Script } from "./mock-router";
import type { RequestLog } from "./extra-requests";

/** Never configured anywhere (tests/peer-fixture); a request there means a payload fetched. */
export const THIRD = "http://third.fixture.test:3013";
export const IMG = "<img src=x onerror=window.__pwned=1>";
export const SCRIPT = "<script>window.__pwned=1</script>";
export const JS_LINK = "[click](javascript:window.__pwned=1)";
export const RAW_JS_LINK = '<a href="javascript:window.__pwned=1">raw js link</a>';
export const CSS = `<style>body{background:url(${THIRD}/x.png)}</style><div style="background:url(${THIRD}/x.png)">css div</div>`;
export const CSS_URL = `url(${THIRD}/x.png)`;
/** Every payload in one string, as a tool result or a model answer would carry it. */
export const ALL = [IMG, SCRIPT, JS_LINK, RAW_JS_LINK, CSS].join(" ");

/**
 * Puts the payloads into the hostile analysis's site-content.json as the browser receives it,
 * so the content tools (search_site_content, get_site_records) return them. The hostile
 * fixture itself carries only the injection phrase (tests/fixtures/sites/index.ts:150-158).
 */
export async function injectHostileContent(page: Page): Promise<{ served: number }> {
  const state = { served: 0 };
  await page.route(/\/p\/[0-9a-f]{32}\/site-content\.json$/, async (route) => {
    const response = await route.fetch();
    const snapshot = (await response.json()) as { source?: string; pages?: unknown[]; records?: Record<string, unknown[]> };
    const source = snapshot.source ?? "http://hostile.fixture.test:3011";
    snapshot.pages = [
      { url: `${source.replace(/\/$/, "")}/candles`, title: `Candles ${IMG} ${SCRIPT}`, text: `candles ${ALL} candles` },
      ...(snapshot.pages ?? []),
    ];
    snapshot.records = { ...(snapshot.records ?? {}) };
    snapshot.records.products = [
      { id: "candle-x", type: "Product", name: `Candle ${IMG}`, description: `${SCRIPT} ${JS_LINK} ${CSS}`, url: "javascript:window.__pwned=1" },
      ...(snapshot.records.products ?? []),
    ];
    state.served++;
    await route.fulfill({ response, json: snapshot });
  });
  return state;
}

/**
 * The front agent delegates to content_specialist; the specialist calls both content tools
 * (their results carry the payloads) and answers with the payloads; the front agent then
 * gives `finalAnswer`.
 */
export function hostileScript(finalAnswer: string): Script {
  return (body) => {
    const tools = toolNames(body);
    const front = tools.includes("content_specialist");
    const result = lastToolResult(body);
    if (result !== null) return { text: front ? finalAnswer : `The snapshot says: ${ALL}` };
    if (front) return { call: [{ name: "content_specialist", args: { request: "candles" } }] };
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    if (tools.includes("website_search_site_content")) calls.push({ name: "website_search_site_content", args: { query: "candles" } });
    if (tools.includes("website_get_site_records")) calls.push({ name: "website_get_site_records", args: { collection: "products" } });
    return calls.length ? { call: calls } : { text: `No tools. ${ALL}` };
  };
}

/** Tool results the runtime recorded in its trace, as text. */
export async function traceToolResults(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const w = window as unknown as { __nsweb?: { trace: { events: Record<string, unknown>[] } } };
    return (w.__nsweb?.trace.events ?? []).filter((e) => e.kind === "tool_result" || e.kind === "tool").map((e) => JSON.stringify(e));
  });
}

/**
 * Nothing executed, nothing fetched: no `window.__pwned`, no inline handler, no
 * `javascript:` href, no image or script from model or tool data, no CSS url() to
 * another origin in the DOM, and no request outside the allowed origins or to the payload paths.
 */
export async function expectInert(page: Page, log: RequestLog, allowedOrigins: readonly string[]) {
  // Give late image loads and handlers a chance to run.
  await page.waitForTimeout(300);
  const dom = await page.evaluate((third) => {
    const all = [...document.querySelectorAll("*")];
    const mount = document.querySelector('[data-testid="preview-mount"]');
    return {
      pwned: (window as unknown as { __pwned?: unknown }).__pwned,
      handlers: all.filter((el) => [...el.attributes].some((a) => /^on/i.test(a.name))).map((el) => el.outerHTML.slice(0, 120)),
      jsHrefs: [...document.querySelectorAll("[href],[src],[action],[formaction]")]
        .filter((el) => ["href", "src", "action", "formaction"].some((n) => /^\s*javascript:/i.test(el.getAttribute(n) ?? "")))
        .map((el) => el.outerHTML.slice(0, 120)),
      jsLinkProps: [...document.querySelectorAll("a")].filter((a) => a.protocol === "javascript:").length,
      mountImages: mount ? [...mount.querySelectorAll("img,image,iframe,object,embed,video,audio,source")].map((el) => el.outerHTML.slice(0, 120)) : [],
      mountScripts: mount ? mount.querySelectorAll("script").length : -1,
      thirdInStyles: [...document.querySelectorAll("style")].filter((s) => (s.textContent ?? "").includes(third)).length,
      thirdInStyleAttrs: all.filter((el) => (el.getAttribute("style") ?? "").includes(third)).map((el) => el.outerHTML.slice(0, 120)),
      thirdInSrc: all.filter((el) => ["src", "srcset", "poster", "data"].some((n) => (el.getAttribute(n) ?? "").includes(third))).length,
    };
  }, THIRD);
  expect(dom.pwned, "window.__pwned").toBeUndefined();
  expect(dom.handlers, "elements with inline event handlers").toEqual([]);
  expect(dom.jsHrefs, "javascript: URLs in the DOM").toEqual([]);
  expect(dom.jsLinkProps).toBe(0);
  expect(dom.mountImages, "images or frames inside the runtime").toEqual([]);
  expect(dom.mountScripts, "scripts inside the runtime").toBe(0);
  expect(dom.thirdInStyles, "style elements naming the third origin").toBe(0);
  expect(dom.thirdInStyleAttrs, "style attributes naming the third origin").toEqual([]);
  expect(dom.thirdInSrc).toBe(0);

  const requests = await log.all();
  expect(requests.filter((r) => !allowedOrigins.includes(r.origin)).map((r) => `${r.method} ${r.url}`), "requests outside the allowed origins").toEqual([]);
  expect(requests.filter((r) => /\/x(\.png)?$/.test(new URL(r.url).pathname)).map((r) => r.url), "requests for the payload images").toEqual([]);
}
