import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "@/lib/config";
import { VERCEL_ENV } from "./helpers/vercel-env";

const SESSION_SECRET = "s".repeat(32);
const KEY = "sk_test_unit_only";
const WEBHOOK = "whsec_unit_only";
const local = (env: Record<string, string | undefined> = {}) => loadConfig({ SESSION_SECRET, ...env });
const errorOf = (load: () => unknown): ConfigError => {
  try {
    load();
  } catch (e) {
    if (e instanceof ConfigError) return e;
    throw e;
  }
  throw new Error("no ConfigError");
};

describe("billing configuration on Vercel", () => {
  // Fails if a release can ship without the instant billing starts or without the Stripe test-mode keys.
  it.each(["BILLING_START", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"])("refuses a missing or blank %s", (name) => {
    for (const value of [undefined, " "]) expect(errorOf(() => loadConfig({ ...VERCEL_ENV, [name]: value })).variable).toBe(name);
  });

  // Fails if the judges' free access could end early by a wrong date (free until 2027-01-18 inclusive).
  it("refuses a BILLING_START before 2027-01-19T00:00:00Z and accepts that instant", () => {
    expect(errorOf(() => loadConfig({ ...VERCEL_ENV, BILLING_START: "2027-01-18T23:59:59.999Z" })).variable).toBe("BILLING_START");
    expect(loadConfig({ ...VERCEL_ENV, BILLING_START: "2027-01-19T00:00:00Z" }).billingStart).toBe(Date.parse("2027-01-19T00:00:00Z"));
  });

  // Fails if a price must exist before Juan decides the amounts.
  it("accepts no price ids, and reads them when set", () => {
    expect(loadConfig(VERCEL_ENV).billing).toEqual({ secretKey: VERCEL_ENV.STRIPE_SECRET_KEY, webhookSecret: VERCEL_ENV.STRIPE_WEBHOOK_SECRET, prices: {} });
    expect(loadConfig({ ...VERCEL_ENV, STRIPE_PRICE_PRO: " price_p1 ", STRIPE_PRICE_AGENCY: "price_a1" }).billing?.prices).toEqual({ pro: "price_p1", agency: "price_a1" });
    expect(loadConfig({ ...VERCEL_ENV, STRIPE_PRICE_PRO: "", STRIPE_PRICE_AGENCY: "price_a1" }).billing?.prices).toEqual({ agency: "price_a1" });
  });
});

describe("test mode only", () => {
  // Fails if a live (or unknown) Stripe key is accepted anywhere, or the error names any part of it.
  it.each(["sk_live_51SecretSecret", "rk_live_51SecretSecret", "pk_test_51SecretSecret", "51SecretSecret", "SK_TEST_51SecretSecret"])("refuses %s without naming it", (key) => {
    for (const load of [() => loadConfig({ ...VERCEL_ENV, STRIPE_SECRET_KEY: key }), () => local({ STRIPE_SECRET_KEY: key, STRIPE_WEBHOOK_SECRET: WEBHOOK })]) {
      const e = errorOf(load);
      expect(e.variable).toBe("STRIPE_SECRET_KEY");
      for (const part of ["51", "Secret", "live", key]) expect(e.message.replace("STRIPE_SECRET_KEY", "")).not.toContain(part);
    }
  });

  // Fails if a restricted test key is refused, or a wrong webhook secret or price id is accepted or echoed.
  it("accepts both test key kinds; refuses a malformed webhook secret and price id without naming them", () => {
    for (const key of [KEY, "rk_test_unit_only"]) expect(local({ STRIPE_SECRET_KEY: key, STRIPE_WEBHOOK_SECRET: WEBHOOK }).billing?.secretKey).toBe(key);
    const hook = errorOf(() => local({ STRIPE_SECRET_KEY: KEY, STRIPE_WEBHOOK_SECRET: "topsecretvalue" }));
    expect(hook.variable).toBe("STRIPE_WEBHOOK_SECRET");
    expect(hook.message).not.toContain("topsecretvalue");
    for (const bad of ["prod_1", "price_", "price_a b", "19.00"]) {
      expect(errorOf(() => local({ STRIPE_SECRET_KEY: KEY, STRIPE_WEBHOOK_SECRET: WEBHOOK, STRIPE_PRICE_PRO: bad })).variable).toBe("STRIPE_PRICE_PRO");
    }
  });

  // Fails if one price id can mean two plans (the plan is mapped from the price id).
  it("refuses the same price id for both plans", () => {
    expect(errorOf(() => local({ STRIPE_SECRET_KEY: KEY, STRIPE_WEBHOOK_SECRET: WEBHOOK, STRIPE_PRICE_PRO: "price_1", STRIPE_PRICE_AGENCY: "price_1" })).variable).toBe("STRIPE_PRICE_AGENCY");
  });
});

describe("billing configuration off Vercel", () => {
  // Fails if local development needs Stripe, or a half configuration is accepted.
  it("is null without variables; the secret key and the webhook secret come together; prices need the key", () => {
    expect(local().billing).toBeNull();
    expect(errorOf(() => local({ STRIPE_SECRET_KEY: KEY })).variable).toBe("STRIPE_WEBHOOK_SECRET");
    expect(errorOf(() => local({ STRIPE_WEBHOOK_SECRET: WEBHOOK })).variable).toBe("STRIPE_SECRET_KEY");
    for (const name of ["STRIPE_PRICE_PRO", "STRIPE_PRICE_AGENCY"]) expect(errorOf(() => local({ [name]: "price_1" })).variable).toBe("STRIPE_SECRET_KEY");
    expect(local({ BILLING_START: "2026-01-01T00:00:00Z" }).billingStart).toBe(Date.parse("2026-01-01T00:00:00Z"));
  });

  // Fails if the configuration object, which routes may log by mistake, can be changed.
  it("is frozen", () => {
    const { billing } = local({ STRIPE_SECRET_KEY: KEY, STRIPE_WEBHOOK_SECRET: WEBHOOK, STRIPE_PRICE_PRO: "price_1" });
    expect(billing).toMatchObject({ prices: { pro: "price_1" } });
    expect(Object.isFrozen(billing)).toBe(true);
    expect(Object.isFrozen(billing?.prices)).toBe(true);
  });
});
