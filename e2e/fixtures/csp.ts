import { test as base, expect, type ConsoleMessage } from "@playwright/test";

export interface CspViolation {
  directive: string;
  blockedURI: string;
}

interface CspFixtures {
  /** Declare the exact violations this test must cause. Any other violation, or a missing one, fails the test. */
  expectCspViolations: (list: CspViolation[]) => void;
  cspViolations: CspViolation[];
}

const matches = (v: CspViolation, e: CspViolation) => v.directive === e.directive && v.blockedURI.startsWith(e.blockedURI);

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
      const exp = expected ?? [];
      const unexpected = cspViolations.filter((v) => !exp.some((e) => matches(v, e)));
      const missing = exp.filter((e) => !cspViolations.some((v) => matches(v, e)));
      const strayConsole = consoleCsp.filter((t) => !exp.some((e) => e.blockedURI && t.includes(e.blockedURI)));
      expect(unexpected, "unexpected CSP violations").toEqual([]);
      expect(missing, "expected CSP violations that did not occur").toEqual([]);
      if (cspViolations.length === 0) expect(strayConsole, "CSP errors in the console").toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };
