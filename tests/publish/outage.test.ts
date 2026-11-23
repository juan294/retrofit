import { describe, expect, it } from "vitest";
import { AccountDataUnavailable } from "@/lib/accounts/data";
import { createMemoryAccountData } from "@/lib/accounts/memory";
import { POST } from "@/app/test-fixtures/outage/route";
import { fixtureOutage, setFixtureOutage } from "@/lib/test-fixtures/outage";

describe("fixtures account data outage", () => {
  // Fails if a test could take account data down outside fixtures mode.
  it("the route answers 404 outside fixtures mode", async () => {
    expect(process.env.RETROFIT_TEST_FIXTURES).toBeFalsy();
    expect((await POST(new Request("http://127.0.0.1:3010/test-fixtures/outage", { method: "POST", body: JSON.stringify({ on: true }) }))).status).toBe(404);
  });

  // Fails if the outage does not fail every operation as the Supabase adapter does, or stays on after it is turned off.
  it("every operation fails closed while it is on, and works when it is off", async () => {
    const data = fixtureOutage(createMemoryAccountData());
    expect(await data.getPublicReport("shop.example.com")).toBeNull();
    setFixtureOutage(true);
    try {
      await expect(data.getPublicReport("shop.example.com")).rejects.toBeInstanceOf(AccountDataUnavailable);
      await expect(data.listPublicHosts(1)).rejects.toBeInstanceOf(AccountDataUnavailable);
    } finally {
      setFixtureOutage(false);
    }
    expect(await data.listPublicHosts(1)).toEqual([]);
  });
});
