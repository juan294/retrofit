import { AccountDataUnavailable, type AccountData } from "@/lib/accounts/data";

// Fixtures mode only: an account data outage that browser tests turn on and off (POST /test-fixtures/outage).
// Production never wraps its account data (getServerDeps uses the adapter itself off fixtures mode).
let on = false;

export function setFixtureOutage(value: boolean): void {
  on = value;
}

/** `data` whose every operation fails as the Supabase adapter's does while the outage is on. */
export function fixtureOutage(data: AccountData): AccountData {
  return new Proxy(data, {
    get(target, name, receiver) {
      const value: unknown = Reflect.get(target, name, receiver);
      if (!on || typeof value !== "function") return value;
      return async () => {
        throw new AccountDataUnavailable(String(name), "fixture_outage");
      };
    },
  });
}
