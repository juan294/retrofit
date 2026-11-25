import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as fixturePage } from "@/app/test-fixtures/billing/[step]/route";
import { BillingUnavailable } from "@/lib/billing/gateway";
import { loadConfig } from "@/lib/config";
import { getBillingGateway, getFixtureBilling } from "@/lib/server/runtime";
import { VERCEL_ENV } from "../helpers/vercel-env";
import { BILLING_ENV } from "./setup";

const SESSION_SECRET = "s".repeat(32);
const g = globalThis as typeof globalThis & { __retrofitRuntime?: { billing?: unknown; fixtureBilling?: unknown } };
beforeEach(() => {
  if (g.__retrofitRuntime) Object.assign(g.__retrofitRuntime, { billing: undefined, fixtureBilling: undefined });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the billing gateway of a deployment", () => {
  // Fails if production can run on the fixtures gateway (free plans for everybody), or a half-configured server pretends to bill.
  it("is the fixtures gateway only in fixtures mode, which Vercel refuses, and unavailable without a key", async () => {
    expect(() => loadConfig({ ...VERCEL_ENV, RETROFIT_TEST_FIXTURES: "1" })).toThrow(/RETROFIT_TEST_FIXTURES/);
    expect(getFixtureBilling(loadConfig(VERCEL_ENV))).toBeNull();
    const none = getBillingGateway(loadConfig({ SESSION_SECRET }));
    for (const run of [() => none.createCustomer({ accountId: "a", email: "e" }), () => none.getSubscriptions("cus_1"), () => none.cancelSubscriptions("cus_1"), () => none.customerOwner("cus_1"), () => none.getPrice("price_1"), () => none.createPortal({ customerId: "cus_1", returnUrl: "u" }), () => none.verifyWebhook("{}", null, 0), () => none.createCheckout({ accountId: "a", customerId: "c", priceId: "p", successUrl: "s", cancelUrl: "c" })]) {
      await expect(run()).rejects.toMatchObject({ code: "not_configured" });
      await expect(run()).rejects.toBeInstanceOf(BillingUnavailable);
    }
    expect(getFixtureBilling(loadConfig({ SESSION_SECRET, RETROFIT_TEST_FIXTURES: "1", ...BILLING_ENV }))).not.toBeNull();
  });

  // Fails if production reaches the billing start without Stripe and nobody is told, or if the alert is raised before it or with Stripe.
  it("without Stripe on Vercel raises an alert from the billing start on, and only then", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const none = loadConfig({ ...VERCEL_ENV, STRIPE_SECRET_KEY: undefined, STRIPE_WEBHOOK_SECRET: undefined });
    const alertsAt = (config: ReturnType<typeof loadConfig>, now: number) => {
      g.__retrofitRuntime!.billing = undefined;
      error.mockClear();
      vi.useFakeTimers({ toFake: ["Date"], now });
      getBillingGateway(config);
      return error.mock.calls.filter(([line]) => String(line).startsWith("[BILLING_ALERT]")).length;
    };
    expect(alertsAt(none, none.billingStart - 1)).toBe(0);
    expect(alertsAt(none, none.billingStart)).toBe(1);
    await expect(getBillingGateway(none).getPrice("price_1")).rejects.toMatchObject({ code: "not_configured" });
    expect(alertsAt(loadConfig(VERCEL_ENV), none.billingStart)).toBe(0);
    expect(alertsAt(loadConfig({ SESSION_SECRET }), none.billingStart)).toBe(0);
  });

  // Fails if a production configuration does not use the Stripe adapter (it checks signatures with the configured secret).
  it("is the Stripe adapter with a key", async () => {
    const gateway = getBillingGateway(loadConfig(VERCEL_ENV));
    await expect(gateway.verifyWebhook("{}", "t=1,v1=00", 1000)).rejects.toThrow("webhook refused");
    expect("complete" in gateway).toBe(false);
  });

  // Fails if the fixtures checkout page (it pays for free) answers outside fixtures mode.
  it("the fixtures checkout page answers 404 outside fixtures mode", async () => {
    expect(process.env.RETROFIT_TEST_FIXTURES).toBeFalsy();
    for (const step of ["checkout", "portal"]) expect((await fixturePage(new Request(`http://127.0.0.1:3010/test-fixtures/billing/${step}?session=cs_1&do=pay`), { params: Promise.resolve({ step }) })).status).toBe(404);
  });

  // Fails if a route that never bills loads the Stripe SDK at start (a slower first answer on the judges' paths).
  it("no source file imports the Stripe SDK statically", () => {
    const src = fileURLToPath(new URL("../../src", import.meta.url));
    const files = fs.readdirSync(src, { recursive: true, encoding: "utf8" }).filter((f) => /\.tsx?$/.test(f));
    expect(files.length).toBeGreaterThan(100);
    const bad = files.filter((f) => /^import (?!type\b)[^;]*from "stripe"/m.test(fs.readFileSync(path.join(src, f), "utf8")));
    expect(bad).toEqual([]);
  });
});
