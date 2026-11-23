import { describe, expect, it } from "vitest";
import { AccountDataUnavailable, type AccountData } from "@/lib/accounts/data";
import { createMemoryAccountData } from "@/lib/accounts/memory";
import { unsubscribeByToken } from "@/lib/api/unsubscribe";
import { captureConsole, testDeps } from "../helpers/server-deps";

describe("GET /unsubscribe?t=<token>", () => {
  // Fails if the link does not unsubscribe its own address, or a second visit changes the recorded time or the answer.
  it("unsubscribes once and gives the same answer on a second visit", async () => {
    const d = testDeps();
    const { unsubscribeToken } = await d.accounts.addNotifySignup("leave@example.test", true);
    expect(await unsubscribeByToken(unsubscribeToken ?? undefined, d.accounts)).toBe("done");
    const first = d.accountsBacking.notify.get("leave@example.test")?.unsubscribedAt;
    expect(first).toEqual(expect.any(Number));
    expect(await unsubscribeByToken(unsubscribeToken ?? undefined, d.accounts)).toBe("done");
    expect(d.accountsBacking.notify.get("leave@example.test")?.unsubscribedAt).toBe(first);
  });

  // Fails if an unknown, malformed, repeated or missing token unsubscribes anything or answers like a valid link.
  it.each([[undefined], [""], ["0123456789abcdef0123456789abcdef"], ["../etc"], [["a", "b"]], ["0123456789ABCDEF0123456789ABCDEF"]])("answers invalid for %j", async (t) => {
    const d = testDeps();
    await d.accounts.addNotifySignup("stay@example.test", false);
    expect(await unsubscribeByToken(t, d.accounts)).toBe("invalid");
    expect(d.accountsBacking.notify.get("stay@example.test")?.unsubscribedAt).toBeNull();
  });

  // Fails if a storage failure throws (the page would show the error page) or logs the token.
  it("answers unavailable when account data fails and never logs the token", async () => {
    const lines: string[] = [];
    captureConsole(lines);
    const accounts: AccountData = {
      ...createMemoryAccountData(),
      unsubscribe: async () => {
        throw new AccountDataUnavailable("unsubscribe", "request_failed");
      },
    };
    const token = "fedcba9876543210fedcba9876543210";
    expect(await unsubscribeByToken(token, accounts)).toBe("unavailable");
    expect(lines.join("\n")).not.toContain(token);
  });
});
