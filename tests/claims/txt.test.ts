/**
 * The fixtures-mode TXT resolver (src/lib/claims/txt.ts): it answers the e2e DNS claim and nothing
 * else, so a server in fixtures mode never uses real DNS for claims.
 */
import { describe, expect, it } from "vitest";
import { FIXTURE_CLAIM_TOKEN } from "@/lib/claims/host";
import { fixtureTxtResolver, isNoRecord } from "@/lib/claims/txt";

describe("fixtureTxtResolver", () => {
  // Fails if the e2e record is missing, not split like a long real record, or another name gets an answer.
  it("answers the blocked fixture's record in two strings and ENOTFOUND for every other name", async () => {
    const records = await fixtureTxtResolver("_retrofit-verification.blocked.fixture.test");
    expect(records.map((r) => r.join(""))).toEqual(["v=spf1 -all", `retrofit-site-verification=${FIXTURE_CLAIM_TOKEN}`]);
    expect(records[1]).toHaveLength(2);
    for (const name of ["_retrofit-verification.bakery.fixture.test", "_retrofit-verification.example.com", "blocked.fixture.test", "_retrofit-verification.blocked.fixture.test.evil.example"]) {
      const error = await fixtureTxtResolver(name).catch((e: unknown) => e);
      expect(isNoRecord(error), name).toBe(true);
    }
  });

  // Fails if a failed lookup is read as "no record" (the owner would be told to wait instead of to retry).
  it("isNoRecord is true only for ENOTFOUND and ENODATA", () => {
    expect(isNoRecord({ code: "ENOTFOUND" })).toBe(true);
    expect(isNoRecord({ code: "ENODATA" })).toBe(true);
    for (const e of [{ code: "ESERVFAIL" }, { code: "ETIMEOUT" }, new Error("x"), null, undefined]) expect(isNoRecord(e)).toBe(false);
  });
});
