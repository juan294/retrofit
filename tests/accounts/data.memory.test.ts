import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { normalizeEmail } from "@/lib/accounts/data";
import { createAccountMemoryBacking, createMemoryAccountData } from "@/lib/accounts/memory";
import { sha256Hex } from "@/lib/security/tokens";
import { fakeClock } from "../helpers/server-deps";
import { runAccountDataContract } from "./data-contract";

runAccountDataContract("memory (two clients, one backing)", async () => {
  const clock = fakeClock(1_700_000_000_000);
  const backing = createAccountMemoryBacking();
  return {
    a: createMemoryAccountData({ clock: clock.now, backing }),
    b: createMemoryAccountData({ clock: clock.now, backing }),
    newAccount: async () => randomUUID(),
  };
});

describe("memory AccountData specifics", () => {
  // Fails if the raw unsubscribe token is kept anywhere in the backing (only its SHA-256 may be stored).
  it("stores only the SHA-256 of the unsubscribe token", async () => {
    const backing = createAccountMemoryBacking();
    const data = createMemoryAccountData({ backing });
    const { unsubscribeToken } = await data.addNotifySignup("raw@example.test", false);
    const dump = JSON.stringify([...backing.notify.values()]);
    expect(dump).not.toContain(unsubscribeToken as string);
    expect(dump).toContain(sha256Hex(unsubscribeToken as string));
  });

  // Fails if the recorded times do not come from the injected clock.
  it("records created and unsubscribed times from its clock", async () => {
    const clock = fakeClock(Date.parse("2026-11-23T10:00:00.000Z"));
    const data = createMemoryAccountData({ clock: clock.now });
    const { unsubscribeToken } = await data.addNotifySignup("time@example.test", false);
    clock.advance(60_000);
    await data.unsubscribe(sha256Hex(unsubscribeToken as string));
    expect(await data.findNotifySignup("time@example.test")).toEqual({
      email: "time@example.test",
      marketingConsent: false,
      createdAt: "2026-11-23T10:00:00.000Z",
      unsubscribedAt: "2026-11-23T10:01:00.000Z",
    });
  });

  // Fails if pruning ignores its time or its bound.
  it("prunes at most `limit` events received before the time", async () => {
    const clock = fakeClock(Date.parse("2027-01-01T00:00:00.000Z"));
    const backing = createAccountMemoryBacking();
    const data = createMemoryAccountData({ clock: clock.now, backing });
    const owner = randomUUID();
    await data.ensureProfile(owner);
    await data.linkBillingCustomer(owner, "cus_prune");
    const state = { plan: "pro", status: "active", currentPeriodEnd: null, cancelAtPeriodEnd: false, subscriptionId: null, unpaidSince: null } as const;
    for (let n = 0; n < 4; n++) {
      await data.applyBillingEvent({ id: `evt_p${n}`, type: "customer.subscription.updated" }, "cus_prune", { ...state, observedAt: new Date(clock.now()).toISOString() });
      clock.advance(86_400_000);
    }
    expect(await data.pruneStripeEvents("2027-01-04T00:00:00.000Z", 2)).toBe(2);
    expect([...backing.stripeEvents.keys()]).toEqual(["evt_p2", "evt_p3"]);
    expect(await data.pruneStripeEvents("2027-01-04T00:00:00.000Z", 2)).toBe(1);
    expect([...backing.stripeEvents.keys()]).toEqual(["evt_p3"]);
  });

  // Fails if an operation writes before yielding (concurrent callers would never interleave, hiding races).
  it("does not touch the backing before yielding", async () => {
    const backing = createAccountMemoryBacking();
    const pending = createMemoryAccountData({ backing }).addNotifySignup("y@example.test", false);
    expect(backing.notify.size).toBe(0);
    await pending;
    expect(backing.notify.size).toBe(1);
  });
});

describe("email addresses", () => {
  // Fails if a valid address is refused, an invalid one accepted, or the address is not trimmed and lower-cased.
  it.each([
    ["Ana@Example.com", "ana@example.com"],
    ["  b.c+tag@sub.example.org ", "b.c+tag@sub.example.org"],
    ["o'neil@example.ie", "o'neil@example.ie"],
  ])("normalizeEmail(%j) -> %j", (input, expected) => {
    expect(normalizeEmail(input)).toBe(expected);
  });

  it.each([[""], ["plain"], ["@example.com"], ["a@"], ["a@b"], ["a b@example.com"], ["a@@example.com"], ["a@exa mple.com"], ["a@example..com"], ["a@.example.com"], ["<a>@example.com"], [`${"l".repeat(65)}@example.com`], [`a@${"d".repeat(250)}.com`]])(
    "normalizeEmail(%j) -> null",
    (input) => {
      expect(normalizeEmail(input)).toBeNull();
    },
  );
});
