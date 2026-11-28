import type { AccountData } from "@/lib/accounts/data";
import type { BillingState } from "@/lib/billing/state";
import { fakeClock, TEST_ACCOUNT, testDeps, type TestDeps, type TestDepsOptions } from "../helpers/server-deps";

export const START = Date.parse("2027-01-20T00:00:00.000Z");
export const PRICES = { pro: "price_unit_pro", agency: "price_unit_agency" };
export const WEBHOOK_SECRET = "whsec_unit_Zq9x";
export const SECRET_KEY = "sk_test_unit_Kk77";
export const BILLING_ENV = { STRIPE_SECRET_KEY: SECRET_KEY, STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET, STRIPE_PRICE_PRO: PRICES.pro, STRIPE_PRICE_AGENCY: PRICES.agency, BILLING_START: "2027-01-20T00:00:00Z" };
export const OWNER = TEST_ACCOUNT.userId;

/** Deps with Stripe configured on a fake clock `offsetMs` after BILLING_START. A wait of the score route (SCORE_WAIT_MS) moves the clock. */
export function billingDeps(offsetMs: number, o: TestDepsOptions = {}) {
  const clock = fakeClock(START + offsetMs);
  return { clock, d: testDeps({ clock: clock.clock, sleep: async (ms) => clock.advance(ms), ...o, env: { ...BILLING_ENV, ...o.env } }) };
}

export const ACTIVE: BillingState = { plan: "pro", status: "active", currentPeriodEnd: "2027-03-01T00:00:00.000Z", cancelAtPeriodEnd: false, subscriptionId: "sub_unit", unpaidSince: null };

/** Stores `state` as the account's billing (its customer linked first). Returns the customer id. */
export async function withBilling(d: Pick<TestDeps, "accounts" | "clock">, accountId: string, state: Partial<BillingState> = {}): Promise<string> {
  const customerId = `cus_unit${accountId.slice(0, 4)}`;
  await d.accounts.ensureProfile(accountId);
  await d.accounts.linkBillingCustomer(accountId, customerId);
  await d.accounts.applyBillingState(customerId, { ...ACTIVE, ...state, observedAt: new Date(d.clock()).toISOString() });
  return customerId;
}

/** A Stripe customer of OWNER, made at the gateway and bound to its account. Returns its id. */
export async function customer(d: Pick<TestDeps, "accounts" | "billing">): Promise<string> {
  const id = await d.billing.createCustomer({ accountId: OWNER, email: TEST_ACCOUNT.email });
  await d.accounts.ensureProfile(OWNER);
  await d.accounts.linkBillingCustomer(OWNER, id);
  return id;
}

/** Account data that records the name of every call. */
export function spiedAccounts(data: AccountData): { accounts: AccountData; calls: string[] } {
  const calls: string[] = [];
  const accounts = new Proxy(data, {
    get(target, name, receiver) {
      const value: unknown = Reflect.get(target, name, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        calls.push(String(name));
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { accounts, calls };
}

/** Account data whose billing reads fail, as a database outage does. */
export function brokenBilling(data: AccountData, operations: readonly (keyof AccountData)[] = ["getBilling"]): AccountData {
  return new Proxy(data, {
    get(target, name, receiver) {
      if ((operations as readonly string[]).includes(String(name))) {
        return async () => {
          throw new Error("database unavailable");
        };
      }
      return Reflect.get(target, name, receiver) as unknown;
    },
  });
}
