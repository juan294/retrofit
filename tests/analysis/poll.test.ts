import { describe, expect, it } from "vitest";
import { pollAction, pollDelay } from "@/components/analysis/poll";

describe("pollDelay", () => {
  // Fails if the backoff schedule in phase-3.md changes.
  it.each([
    [0, 1000],
    [9_999, 1000],
    [10_000, 2000],
    [29_999, 2000],
    [30_000, 5000],
    [600_000, 5000],
  ])("at %i ms waits %i ms", (elapsed, delay) => {
    expect(pollDelay(elapsed)).toBe(delay);
  });

  // Fails if the page stops polling on a state that is not final for the visitor.
  it("stops on failed and expired only, and reads the result once the score is ready", () => {
    expect(pollAction({ status: "failed", scoreReady: false })).toBe("stop");
    expect(pollAction({ status: "expired", scoreReady: false })).toBe("stop");
    expect(pollAction({ status: "ready", scoreReady: true })).toBe("read-result");
    for (const status of ["queued", "crawling"]) expect(pollAction({ status, scoreReady: false })).toBe("poll");
  });

  // V01. Fails if ready without a score stops polling (the page showed "Reading the site" forever).
  it("keeps polling when the status is ready but the score is not", () => {
    expect(pollAction({ status: "ready", scoreReady: false })).toBe("poll");
  });
});
