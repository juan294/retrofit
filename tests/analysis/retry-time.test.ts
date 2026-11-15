import { describe, expect, it } from "vitest";
import { localizeRetry } from "@/components/analysis/retry-time";

describe("localizeRetry", () => {
  // Fails if the client keeps showing a UTC time as if it were local.
  it("replaces the UTC time with the visitor's local time", () => {
    const at = "2026-11-15T15:00:00.000Z";
    const out = localizeRetry("You reached the limit of 20 analyses per hour. Try again at 15:00 UTC.", at, "en-GB");
    const expected = new Date(at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
    expect(out).toBe(`You reached the limit of 20 analyses per hour. Try again at ${expected}.`);
  });

  it("keeps the message when no retryAt is given or it is invalid", () => {
    expect(localizeRetry("Try again at 15:00 UTC.", undefined)).toBe("Try again at 15:00 UTC.");
    expect(localizeRetry("Try again at 15:00 UTC.", "nope")).toBe("Try again at 15:00 UTC.");
  });
});
