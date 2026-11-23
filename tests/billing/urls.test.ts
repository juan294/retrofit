import { describe, expect, it } from "vitest";
import { isBillingUrl } from "@/lib/billing/urls";

const ORIGIN = "http://127.0.0.1:3010";

describe("billing redirect URLs", () => {
  // Fails if the browser or the server can be sent anywhere but Stripe's own pages.
  it.each([
    ["https://checkout.stripe.com/c/pay/cs_test_1#x", true],
    ["https://billing.stripe.com/p/session/test_1", true],
    ["http://checkout.stripe.com/c/pay/cs_test_1", false],
    ["https://checkout.stripe.com.evil.example/c", false],
    ["https://evil.example/checkout.stripe.com", false],
    ["https://checkout.stripe.com@evil.example/", false],
    ["https://user:pw@checkout.stripe.com/", false],
    ["https://checkout.stripe.com:8443/", false],
    ["https://stripe.com/", false],
    ["https://dashboard.stripe.com/", false],
    ["//checkout.stripe.com/c", false],
    ["/c/pay", false],
    ["javascript:alert(1)//checkout.stripe.com", false],
    ["data:text/html,https://checkout.stripe.com", false],
    ["", false],
    [null, false],
    [42, false],
  ])("%j -> %s", (url, ok) => {
    expect(isBillingUrl(url, null)).toBe(ok);
  });

  // Fails if the fixture page is accepted outside fixtures mode, or fixtures mode accepts another path or origin.
  it("accepts the fixture pages only with the fixtures origin", () => {
    expect(isBillingUrl(`${ORIGIN}/test-fixtures/billing/checkout?session=cs_1`, null)).toBe(false);
    expect(isBillingUrl(`${ORIGIN}/test-fixtures/billing/checkout?session=cs_1`, ORIGIN)).toBe(true);
    for (const bad of [`${ORIGIN}/account`, `${ORIGIN}/test-fixtures/clock`, `${ORIGIN}/test-fixtures/billing/../clock`, "http://127.0.0.1:3011/test-fixtures/billing/x", `${ORIGIN}@evil.example/test-fixtures/billing/x`]) expect(isBillingUrl(bad, ORIGIN), bad).toBe(false);
    expect(isBillingUrl("https://checkout.stripe.com/c", ORIGIN)).toBe(true);
  });
});
