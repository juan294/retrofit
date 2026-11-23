import { describe, expect, it } from "vitest";
import { hashToken, normalizeEmail, unsubscribeUrl } from "@/lib/accounts/data";
import { createAccountMemoryBacking, createMemoryAccountData } from "@/lib/accounts/memory";
import { fakeClock } from "../helpers/server-deps";
import { runAccountDataContract } from "./data-contract";

runAccountDataContract("memory (two clients, one backing)", async () => {
  const clock = fakeClock(1_700_000_000_000);
  const backing = createAccountMemoryBacking();
  return {
    a: createMemoryAccountData({ clock: clock.now, backing }),
    b: createMemoryAccountData({ clock: clock.now, backing }),
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
    expect(dump).toContain(hashToken(unsubscribeToken as string));
  });

  // Fails if the recorded times do not come from the injected clock.
  it("records created and unsubscribed times from its clock", async () => {
    const clock = fakeClock(Date.parse("2026-11-23T10:00:00.000Z"));
    const data = createMemoryAccountData({ clock: clock.now });
    const { unsubscribeToken } = await data.addNotifySignup("time@example.test", false);
    clock.advance(60_000);
    await data.unsubscribe(hashToken(unsubscribeToken as string));
    expect(await data.findNotifySignup("time@example.test")).toEqual({
      email: "time@example.test",
      marketingConsent: false,
      createdAt: "2026-11-23T10:00:00.000Z",
      unsubscribedAt: "2026-11-23T10:01:00.000Z",
    });
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

describe("email and token helpers", () => {
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

  // Fails if the link does not reach GET /unsubscribe on the public origin with the raw token, or the token is not URL-safe checked.
  it("unsubscribeUrl builds the link every message carries", () => {
    const token = "0123456789abcdef0123456789abcdef";
    expect(unsubscribeUrl("https://retrofit.thecreativetoken.com", token)).toBe(`https://retrofit.thecreativetoken.com/unsubscribe?t=${token}`);
    expect(() => unsubscribeUrl("https://retrofit.test", "../x")).toThrow(RangeError);
  });

  // Fails if the hash is not SHA-256 hex of the token (the stored hash would never match the link).
  it("hashToken is SHA-256 in hex", () => {
    expect(hashToken("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
