import { test as base, expect, type Browser, type BrowserContext, type ConsoleMessage } from "@playwright/test";

import { evaluateCsp, type CspViolation } from "./csp-eval";

export type { CspViolation };

interface NetworkFixtures {
  /** Requests to a real external host that no test mock answered. Any entry fails the test. */
  externalRequests: string[];
}

interface CspFixtures {
  /** Declare the exact violations this test must cause. Any other violation, or a missing one, fails the test. */
  expectCspViolations: (list: CspViolation[]) => void;
  cspViolations: CspViolation[];
}

interface CspMonitor {
  /** Violations reported by any page of any context the test uses. */
  readonly seen: CspViolation[];
  /** CSP console messages from those pages. */
  readonly console: string[];
}

const LOCAL_HOST = /^(127\.0\.0\.1|localhost|[a-z0-9-]+\.fixture\.test)$/;
const CSP_CONSOLE = /Content Security Policy|Refused to (load|execute|connect|apply|frame)/;

/**
 * Watches every page of `context`, including pages opened later: the binding and the init script
 * are context-wide, and the context's console event covers all of its pages.
 */
async function watchContext(context: BrowserContext, monitor: CspMonitor) {
  await context.exposeBinding("__retrofitReportCsp", (_source, v: CspViolation) => {
    monitor.seen.push(v);
  });
  await context.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (e) => {
      (window as unknown as { __retrofitReportCsp: (v: unknown) => void }).__retrofitReportCsp({
        directive: e.effectiveDirective,
        blockedURI: e.blockedURI,
      });
    });
  });
  context.on("console", (m: ConsoleMessage) => {
    const t = m.text();
    if (CSP_CONSOLE.test(t)) monitor.console.push(t);
  });
}

export const test = base.extend<CspFixtures & NetworkFixtures & { cspMonitor: CspMonitor }>({
  externalRequests: [
    async ({ context }, use) => {
      const seen: string[] = [];
      // Context routes have the lowest priority: a test's page.route mock still answers first.
      await context.route(
        (url) => /^https?:$/.test(url.protocol) && !LOCAL_HOST.test(url.hostname),
        (route) => {
          seen.push(route.request().url());
          return route.abort("blockedbyclient");
        },
      );
      await use(seen);
      expect(seen, "requests to real external hosts (mock them or remove them)").toEqual([]);
    },
    { auto: true },
  ],
  // Every page of the test's context, and of every context the test creates with
  // browser.newContext() or browser.newPage(), reports to one monitor.
  cspMonitor: [
    async ({ context, browser }, use) => {
      const monitor: CspMonitor = { seen: [], console: [] };
      await watchContext(context, monitor);
      const created: BrowserContext[] = [];
      const newContext = browser.newContext;
      const newPage = browser.newPage;
      browser.newContext = async (...args: Parameters<Browser["newContext"]>) => {
        const extra = await newContext.apply(browser, args);
        created.push(extra);
        await watchContext(extra, monitor);
        return extra;
      };
      // browser.newPage makes its own context; build it through the watched newContext instead.
      browser.newPage = async (...args: Parameters<Browser["newPage"]>) => {
        const extra = await browser.newContext(...args);
        const page = await extra.newPage();
        page.on("close", () => void extra.close().catch(() => undefined));
        return page;
      };
      await use(monitor);
      browser.newContext = newContext;
      browser.newPage = newPage;
      await Promise.all(created.map((c) => c.close().catch(() => undefined)));
    },
    { auto: true },
  ],
  cspViolations: [
    async ({ cspMonitor }, use) => {
      await use(cspMonitor.seen);
    },
    { auto: true },
  ],
  expectCspViolations: [
    async ({ page, cspMonitor }, use) => {
      let expected: CspViolation[] | undefined;
      await use((list) => {
        expected = list;
      });
      // Let late events (images, async fetches) arrive.
      await page.waitForTimeout(100).catch(() => {});
      const result = evaluateCsp(cspMonitor.seen, expected ?? [], cspMonitor.console);
      expect(result.unexpected, "unexpected CSP violations").toEqual([]);
      expect(result.missing, "expected CSP violations that did not occur").toEqual([]);
      expect(result.strayConsole, "CSP errors in the console that match no expected violation").toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };
