import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "@/lib/config";
import { crawlSite } from "@/lib/fetch/crawl";
import { createFetchContext } from "@/lib/fetch/context";
import { CHECK_IDS, MAX_EVIDENCE_CHARS, MAX_REPORT_BYTES, SCORE_WEIGHTS, scoreChecks, scoreSnapshot, type CheckResult, type ScoreReport } from "@/lib/score/score";
import type { Snapshot } from "@/lib/snapshot/types";
import { createMemoryStore } from "@/lib/store/memory";
import expected from "../fixtures/expected-scores.json";
import { agentified, bakery, hostile, INJECTION, noindexPage, spaOnly, type FixtureSite } from "../fixtures/sites";
import { serveSites } from "../helpers/sites";

const config = loadConfig({ SESSION_SECRET: "x".repeat(32), RETROFIT_TEST_FIXTURES: "1", FETCH_MAX_BYTES: "1048576" });

// Whole-site fixtures. `blocked` is left out: its robots.txt stops the crawl, so there is no snapshot to score.
const SITES: Record<keyof typeof expected.sites, FixtureSite> = { bakery, spaOnly, agentified, hostile, noindexPage };
const host = (name: string) => `${name.toLowerCase()}.fixture.test`;

let server: Awaited<ReturnType<typeof serveSites>>;
const reports = new Map<string, ScoreReport>();
const snapshots = new Map<string, Snapshot>();

beforeAll(async () => {
  server = await serveSites(() => Object.fromEntries(Object.entries(SITES).map(([name, site]) => [host(name), site])));
  for (const name of Object.keys(SITES)) {
    const fetch = createFetchContext({ config, store: createMemoryStore(), minIntervalMs: 1 });
    const snapshot = (await crawlSite(server.origin(host(name)), { config, fetch, clock: Date.now }))!;
    snapshots.set(name, snapshot);
    reports.set(name, scoreSnapshot(snapshot));
  }
}, 60_000);
afterAll(async () => {
  await server?.close();
});

describe("score/v1 table", () => {
  // Fails if a weight changes without a new score version, or a check is added or dropped.
  it("has 16 checks in table order whose weights total 100", () => {
    expect(CHECK_IDS).toEqual([
      "aw.manifest", "aw.network-valid", "aw.cors",
      "disc.robots-agents", "disc.sitemap", "disc.llms-txt",
      "read.server-text", "read.title-description", "read.lang",
      "data.jsonld", "data.business", "data.offers", "data.hours",
      "act.form-labels", "act.task-links", "sec.https",
    ]);
    expect(Object.values(SCORE_WEIGHTS).reduce((a, b) => a + b, 0)).toBe(100);
    expect(SCORE_WEIGHTS).toMatchObject({ "aw.manifest": 15, "aw.network-valid": 10, "read.server-text": 12, "data.hours": 3, "read.lang": 2 });
  });
});

describe("scoreChecks", () => {
  const make = (results: CheckResult["result"][]): CheckResult[] =>
    CHECK_IDS.map((id, i) => ({ id, group: "g", weight: SCORE_WEIGHTS[id], result: results[i] ?? "not-checked", rule: "r", evidence: "e" }));

  // Fails if the score rounds instead of flooring, or divides by all weights instead of checked weights.
  it("floors passed weight over checked weight", () => {
    // aw.manifest 15 pass, aw.network-valid 10 fail, aw.cors 5 fail, disc.robots-agents 8 pass: 23 / 38 = 60.5.
    const s = scoreChecks(make(["pass", "fail", "fail", "pass"]));
    expect(s).toMatchObject({ score: 60, checked: 4, passed: 2 });
    expect(s.summary).toBe("Agent-readiness score 60 of 100 (score/v1). 2 of 4 checked checks passed. 12 checks were not checked.");
  });

  // Fails if the singular form is lost.
  it("uses the singular for one check not checked", () => {
    const s = scoreChecks(make([...Array(15).fill("pass"), "not-checked"]));
    expect(s.score).toBe(100);
    expect(s.summary).toBe("Agent-readiness score 100 of 100 (score/v1). 15 of 15 checked checks passed. 1 check was not checked.");
  });

  // Fails if a score is given with fewer than 3 checked checks.
  it("gives no score with fewer than 3 checked checks", () => {
    const s = scoreChecks(make(["pass", "pass"]));
    expect(s).toMatchObject({ score: null, checked: 2, passed: 2 });
    expect(s.summary).toBe("Retrofit could check only 2 of 16 checks, so there is no score.");
    expect(scoreChecks(make(["pass", "fail", "fail"])).score).toBe(50);
  });
});

describe("scoreSnapshot on the fixture sites", () => {
  for (const name of Object.keys(SITES) as (keyof typeof expected.sites)[]) {
    // Fails if any check rule, weight or the score formula drifts from score/v1.
    it(`${name} matches the golden file`, () => {
      const report = reports.get(name)!;
      const want = expected.sites[name];
      expect(Object.fromEntries(report.checks.map((c) => [c.id, c.result]))).toEqual(want.checks);
      expect({ score: report.score, checked: report.checked, passed: report.passed }).toEqual({ score: want.score, checked: want.checked, passed: want.passed });
    });
  }

  // Fails if the report shape drifts from the tool contract or names the wrong URL.
  it("returns the contract's report shape", () => {
    const report = reports.get("bakery")!;
    const snapshot = snapshots.get("bakery")!;
    expect(Object.keys(report)).toEqual(["scoreVersion", "url", "finalUrl", "host", "fetchedAt", "score", "checked", "total", "passed", "webmcp", "summary", "checks"]);
    expect(report).toMatchObject({ scoreVersion: "score/v1", url: snapshot.inputUrl, finalUrl: snapshot.finalUrl, host: snapshot.host, fetchedAt: snapshot.fetchedAt, total: 16, webmcp: "not checked" });
    expect(report.checks.map((c) => c.id)).toEqual(CHECK_IDS);
    expect(report.summary).toBe("Agent-readiness score 62 of 100 (score/v1). 11 of 16 checked checks passed. All 16 checks were checked.");
    expect(report.checks.find((c) => c.id === "data.hours")).toMatchObject({ group: "Structured data", weight: 3, rule: "OpeningHoursSpecification present (not checked without LocalBusiness)" });
  });

  // Fails if evidence quotes fetched prose or grows without bound.
  it("keeps hostile text out of the report and the report under 16 KB", () => {
    for (const [, report] of reports) {
      const body = JSON.stringify(report);
      expect(Buffer.byteLength(body)).toBeLessThanOrEqual(MAX_REPORT_BYTES);
      for (const c of report.checks) expect(c.evidence.length).toBeLessThanOrEqual(MAX_EVIDENCE_CHARS);
    }
    const hostileBody = JSON.stringify(reports.get("hostile")!);
    expect(hostileBody).not.toContain(INJECTION);
    expect(hostileBody.toLowerCase()).not.toContain("ignore all previous");
    // The bakery's prose (title, description, form labels) never appears either.
    const bakeryBody = JSON.stringify(reports.get("bakery")!);
    for (const prose of ["Crumb and Crust Bakery", "Neighbourhood sourdough", "Pickup time", "Your email"]) expect(bakeryBody).not.toContain(prose);
  });
});
