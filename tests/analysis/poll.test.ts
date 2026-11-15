import { describe, expect, it } from "vitest";
import { FINAL_STATUSES, pollDelay } from "@/components/analysis/poll";

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

  it("stops on ready, failed and expired only", () => {
    expect([...FINAL_STATUSES].sort()).toEqual(["expired", "failed", "ready"]);
  });
});
