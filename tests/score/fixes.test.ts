import { describe, expect, it } from "vitest";
import { CHECK_DEFINITIONS } from "@/lib/score/checks";
import { FIX_HINTS, fixFirst } from "@/lib/score/fixes";

const check = (id: string, weight: number, result: "pass" | "fail" | "not-checked") => ({ id, weight, result });

describe("fix hints", () => {
  // Fails if a score/v1 check has no plain-language fix, so "Fix these first" could show a blank line.
  it("every check has a one-sentence fix", () => {
    for (const d of CHECK_DEFINITIONS) {
      expect(FIX_HINTS[d.id]).toMatch(/^[A-Z].{20,220}\.$/);
    }
  });

  // Fails if the list shows passed or unchecked checks, more than three, or not the heaviest failures first.
  it("fixFirst returns the three heaviest failures, ties in definition order", () => {
    const checks = [
      check("disc.sitemap", 4, "fail"),
      check("aw.manifest", 15, "fail"),
      check("read.server-text", 12, "pass"),
      check("data.hours", 3, "not-checked"),
      check("disc.llms-txt", 4, "fail"),
      check("data.jsonld", 8, "fail"),
    ];
    expect(fixFirst(checks).map((c) => c.id)).toEqual(["aw.manifest", "data.jsonld", "disc.sitemap"]);
    expect(fixFirst([check("sec.https", 4, "pass")])).toEqual([]);
  });
});
