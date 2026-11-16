import { describe, expect, it } from "vitest";
import { normalizeCapture } from "../../e2e/support/runtime-capture";

describe("normalizeCapture", () => {
  // Fails if the snapshot date in the generated instructions is left in the capture: the capture
  // would then change on every calendar day and rewrite a tracked fixture during the gate.
  it("replaces the snapshot date so a capture on another day writes the same file", () => {
    const day1 = normalizeCapture("a snapshot of public pages taken on 2026-11-15. And bakery.fixture.test:3011, taken on 2026-11-15.");
    const day2 = normalizeCapture("a snapshot of public pages taken on 2026-11-16. And bakery.fixture.test:3011, taken on 2026-11-16.");
    expect(day1).toBe(day2);
    expect(day1).toBe("a snapshot of public pages taken on SNAPSHOT_DATE. And bakery.fixture.test:3011, taken on SNAPSHOT_DATE.");
  });

  // Fails if analysis ids, call ids, UUIDs or ISO timestamps are no longer normalized.
  it("replaces analysis ids, call ids, UUIDs and timestamps", () => {
    const text = "http://127.0.0.1:3010/p/0123456789abcdef0123456789abcdef call_12_3 01234567-89ab-cdef-0123-456789abcdef 2026-11-16T07:12:00.123Z";
    expect(normalizeCapture(text)).toBe("http://127.0.0.1:3010/p/ANALYSIS_ID call_ID UUID TIMESTAMP");
  });
});
