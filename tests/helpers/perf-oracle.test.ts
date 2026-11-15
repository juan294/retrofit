import { describe, expect, it } from "vitest";
import { isComplete, parseStatusSample } from "./perf-oracle";

const work = (o: Partial<{ foreground: number; dispatch: unknown }> = {}) => JSON.stringify({ foreground: 2, dispatch: { started: 0, operations: 1, claims: 1 }, ...o });
const headers = (h: Record<string, string>) => new Headers(h);
const good = () => headers({ "x-retrofit-store-reads": "2", "x-retrofit-store-work": work() });
const crawling = { status: "crawling", step: "page 2", scoreReady: false };

describe("perf oracle (validation V15)", () => {
  // Fails if a valid sample is refused or its numbers are lost.
  it("reads a valid sample", () => {
    expect(parseStatusSample(200, good(), crawling)).toEqual({
      status: "crawling",
      scoreReady: false,
      reads: 2,
      foregroundOps: 2,
      dispatch: { started: 0, operations: 1, claims: 1 },
    });
  });

  // Fails if a missing telemetry header reads as zero (Number(null) === 0) instead of failing.
  it("refuses a missing or empty read-count header", () => {
    expect(() => parseStatusSample(200, headers({ "x-retrofit-store-work": work() }), crawling)).toThrow(/x-retrofit-store-reads/);
    expect(() => parseStatusSample(200, headers({ "x-retrofit-store-reads": "", "x-retrofit-store-work": work() }), crawling)).toThrow(/x-retrofit-store-reads/);
  });

  // Fails if non-numeric, negative or fractional telemetry is accepted.
  it.each(["abc", "-1", "1.5", "Infinity", "NaN"])("refuses the read count %s", (value) => {
    expect(() => parseStatusSample(200, headers({ "x-retrofit-store-reads": value, "x-retrofit-store-work": work() }), crawling)).toThrow(/x-retrofit-store-reads/);
  });

  // Fails if missing or malformed store-work telemetry is accepted.
  it("refuses missing or malformed store-work telemetry", () => {
    expect(() => parseStatusSample(200, headers({ "x-retrofit-store-reads": "2" }), crawling)).toThrow(/x-retrofit-store-work/);
    expect(() => parseStatusSample(200, headers({ "x-retrofit-store-reads": "2", "x-retrofit-store-work": "{" }), crawling)).toThrow(/x-retrofit-store-work/);
    expect(() => parseStatusSample(200, headers({ "x-retrofit-store-reads": "2", "x-retrofit-store-work": work({ foreground: -1 }) }), crawling)).toThrow(/foreground/);
    expect(() => parseStatusSample(200, headers({ "x-retrofit-store-reads": "2", "x-retrofit-store-work": work({ dispatch: { started: 0, operations: "1", claims: 1 } }) }), crawling)).toThrow(/dispatch/);
    // An owner's status request always dispatches; no dispatch means it was a 404 or the dispatch failed.
    expect(() => parseStatusSample(200, headers({ "x-retrofit-store-reads": "2", "x-retrofit-store-work": work({ dispatch: null }) }), crawling)).toThrow(/dispatch/);
  });

  // Fails if an unsuccessful response counts as a sample.
  it("refuses a status other than 200", () => {
    expect(() => parseStatusSample(503, good(), { error: "unavailable" })).toThrow(/HTTP 503/);
  });

  // Fails if ready without a score passes as completion (validation V01 was hidden this way).
  it("refuses ready without a usable score, and a failed analysis", () => {
    expect(() => parseStatusSample(200, good(), { status: "ready", step: "ready", scoreReady: false })).toThrow(/ready without a score/);
    expect(() => parseStatusSample(200, good(), { status: "failed", step: "failed", scoreReady: false })).toThrow(/failed/);
    expect(() => parseStatusSample(200, good(), { status: "crawling" })).toThrow(/scoreReady/);
  });

  // Fails if completion is judged by status alone.
  it("is complete only when ready with a score", () => {
    expect(isComplete(parseStatusSample(200, good(), { status: "ready", step: "ready", scoreReady: true }))).toBe(true);
    expect(isComplete(parseStatusSample(200, good(), crawling))).toBe(false);
  });
});
