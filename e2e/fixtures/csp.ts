import { test as base, expect, type ConsoleMessage } from "@playwright/test";

import { evaluateCsp, type CspViolation } from "./csp-eval";

export type { CspViolation };

interface CspFixtures {
  /** Declare the exact violations this test must cause. Any other violation, or a missing one, fails the test. */
  expectCspViolations: (list: CspViolation[]) => void;
  cspViolations: CspViolation[];
}

export const test = base.extend<CspFixtures>({
  cspViolations: [
    async ({ page }, use) => {
      const seen: CspViolation[] = [];
      await page.exposeBinding("__retrofitReportCsp", (_source, v: CspViolation) => {
        seen.push(v);
      });
      await page.addInitScript(() => {
        document.addEventListener("securitypolicyviolation", (e) => {
          (window as unknown as { __retrofitReportCsp: (v: unknown) => void }).__retrofitReportCsp({
            directive: e.effectiveDirective,
            blockedURI: e.blockedURI,
          });
        });
      });
      await use(seen);
    },
    { auto: true },
  ],
  expectCspViolations: [
    async ({ page, cspViolations }, use) => {
      let expected: CspViolation[] | undefined;
      const consoleCsp: string[] = [];
      const onConsole = (m: ConsoleMessage) => {
        const t = m.text();
        if (/Content Security Policy|Refused to (load|execute|connect|apply|frame)/.test(t)) consoleCsp.push(t);
      };
      page.on("console", onConsole);
      await use((list) => {
        expected = list;
      });
      page.off("console", onConsole);
      // Let late events (images, async fetches) arrive.
      await page.waitForTimeout(100).catch(() => {});
      const result = evaluateCsp(cspViolations, expected ?? [], consoleCsp);
      expect(result.unexpected, "unexpected CSP violations").toEqual([]);
      expect(result.missing, "expected CSP violations that did not occur").toEqual([]);
      expect(result.strayConsole, "CSP errors in the console that match no expected violation").toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };
