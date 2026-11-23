/**
 * The fixtures-mode TXT records (src/lib/test-fixtures/txt.ts, POST /test-fixtures/txt): browser tests
 * publish the records a DNS claim needs; every other name answers ENOTFOUND, so a server in fixtures
 * mode never uses real DNS. The route answers 404 outside fixtures mode.
 */
import { describe, expect, it } from "vitest";
import { POST } from "@/app/test-fixtures/txt/route";
import { isNoRecord } from "@/lib/claims/txt";
import { fixtureTxtResolver, setFixtureTxt } from "@/lib/test-fixtures/txt";

describe("fixtures TXT records", () => {
  // Fails if a published record is not answered as published (split strings kept), or another name gets an answer.
  it("answers the records set for a name and ENOTFOUND for every other name", async () => {
    const name = "_retrofit-verification.store.fixture.test";
    setFixtureTxt(name, [["v=spf1 -all"], ["retrofit-site-verification=", "abc"]]);
    expect(await fixtureTxtResolver(name)).toEqual([["v=spf1 -all"], ["retrofit-site-verification=", "abc"]]);
    for (const other of ["_retrofit-verification.other.fixture.test", `${name}.evil.example`, "store.fixture.test"]) {
      expect(isNoRecord(await fixtureTxtResolver(other).catch((e: unknown) => e)), other).toBe(true);
    }
    setFixtureTxt(name, []);
    expect(isNoRecord(await fixtureTxtResolver(name).catch((e: unknown) => e))).toBe(true);
  });

  // Fails if anyone can publish TXT records on a server outside fixtures mode.
  it("the route answers 404 outside fixtures mode", async () => {
    expect(process.env.RETROFIT_TEST_FIXTURES).toBeFalsy();
    const res = await POST(new Request("http://127.0.0.1:3010/test-fixtures/txt", { method: "POST", body: JSON.stringify({ name: "_retrofit-verification.x.fixture.test", records: [["a"]] }) }));
    expect(res.status).toBe(404);
  });

  // Fails if a failed lookup is read as "no record" (the owner would be told to wait instead of to retry).
  it("isNoRecord is true only for ENOTFOUND and ENODATA", () => {
    expect(isNoRecord({ code: "ENOTFOUND" })).toBe(true);
    expect(isNoRecord({ code: "ENODATA" })).toBe(true);
    for (const e of [{ code: "ESERVFAIL" }, { code: "ETIMEOUT" }, new Error("x"), null, undefined]) expect(isNoRecord(e)).toBe(false);
  });
});
