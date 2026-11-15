import { test as base, expect } from "../../e2e/fixtures/csp";
import { PEER_HOST } from "@/lib/peer/host";
import { prodUrl, writeCase } from "../support/report";

export type { CspViolation } from "../../e2e/fixtures/csp";

/** The hosts a production case may reach for real: Retrofit's deployment and its peer. Every other host must be mocked. */
export const PRODUCTION_HOSTS: ReadonlySet<string> = new Set([new URL(prodUrl()).hostname, PEER_HOST]);

export interface Evidence {
  /** Names the required production case (tools/release/required-production-cases.json) this test proves. */
  case(id: string): void;
  /** Adds data to the case report. Never put a secret here. */
  record(extra: Record<string, unknown>): void;
}

/**
 * The local CSP fixture (e2e/fixtures/csp.ts), unchanged, with two production changes:
 * - externalRequests allows the two production hosts; any other unmocked host is still
 *   blocked and fails the test (the Otari router is answered by the in-browser mock router).
 * - evidence writes the case report through writeCase after every other check has run:
 *   `page` and `externalRequests` depend on it, so it is set up first and torn down last,
 *   and its status includes the CSP and network checks that run at their teardown.
 */
export const test = base.extend<{ evidence: Evidence; externalRequests: string[] }>({
  evidence: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use, testInfo) => {
      let caseId: string | null = null;
      const extra: Record<string, unknown> = {};
      await use({
        case: (id) => {
          caseId = id;
        },
        record: (more) => Object.assign(extra, more),
      });
      if (caseId === null) throw new Error("this production test named no case: call evidence.case(<id>) first");
      const passed = testInfo.status === "passed" && testInfo.errors.length === 0;
      await writeCase(caseId, passed ? "passed" : "failed", {
        test: testInfo.titlePath.slice(1).join(" > "),
        durationMs: testInfo.duration,
        ...(passed ? {} : { errors: testInfo.errors.map((e) => (e.message ?? String(e.value ?? "")).slice(0, 2000)) }),
        ...extra,
      });
    },
    { auto: true },
  ],
  page: async ({ page, evidence: _evidence }, provide) => {
    await provide(page);
  },
  // Overrides keep the base registration's options, so this still runs for every test (auto).
  externalRequests: async ({ context, evidence: _evidence }, provide) => {
    const seen: string[] = [];
    // Context routes have the lowest priority: a test's page.route mock still answers first.
    await context.route(
      (url) => /^https?:$/.test(url.protocol) && !PRODUCTION_HOSTS.has(url.hostname),
      (route) => {
        seen.push(route.request().url());
        return route.abort("blockedbyclient");
      },
    );
    await provide(seen);
    expect(seen, "requests to hosts outside the production deployment and its peer (mock them or remove them)").toEqual([]);
  },
});

export { expect };
