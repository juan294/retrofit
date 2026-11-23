import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountData } from "@/lib/accounts/data";
import { deleteAccount } from "@/lib/accounts/delete";
import { indexAccountAnalyses } from "@/lib/analysis/owner";
import { ACCOUNT_COOKIE, createAccountSession, readAccount, readAccountByToken } from "@/lib/accounts/session";
import { handleAccountDelete } from "@/lib/api/account-delete";
import type { AuthGateway } from "@/lib/auth/gateway";
import { createFixtureAuth } from "@/lib/test-fixtures/auth";
import { createAccountMemoryBacking, createMemoryAccountData } from "@/lib/accounts/memory";
import { ACCOUNT_TEXT } from "@/lib/site/account-texts";
import { fakeClock, PUBLIC_ORIGIN, testDeps } from "../helpers/server-deps";

const REPORT = { host: "d.example", report: { score: 12, host: "d.example" }, fetchedAt: "2026-11-22T08:00:00.000Z" };

afterEach(() => vi.restoreAllMocks());

/**
 * A signed-in account with a profile, two saved reports and two sessions (this browser and another),
 * on deps whose auth and account data record their calls in one ordered log.
 */
async function signedIn(o: { failData?: boolean } = {}) {
  const clock = fakeClock();
  const log: string[] = [];
  const fixture = createFixtureAuth({ clock: clock.clock, origin: PUBLIC_ORIGIN });
  await fixture.signInWithOtp("gone@example.test", `${PUBLIC_ORIGIN}/auth/confirm`);
  const userId = fixture.userIdOf("gone@example.test")!;
  const auth: AuthGateway = {
    signInWithOtp: (...a) => fixture.signInWithOtp(...a),
    verifyOtp: (...a) => fixture.verifyOtp(...a),
    getUser: async (id) => (log.push("auth.getUser"), fixture.getUser(id)),
    deleteUser: async (id) => (log.push("auth.deleteUser"), fixture.deleteUser(id)),
  };
  const backing = createAccountMemoryBacking();
  const memory = createMemoryAccountData({ clock: clock.clock, backing });
  const accounts: AccountData = {
    ...memory,
    deleteAccountData: async (id) => {
      log.push("accounts.deleteAccountData");
      if (o.failData) throw new Error("database unavailable");
      return memory.deleteAccountData(id);
    },
  };
  const d = testDeps({ clock: clock.clock, auth, accounts });
  await accounts.ensureProfile(userId);
  await accounts.saveReport(userId, REPORT);
  await accounts.saveReport(userId, { ...REPORT, fetchedAt: "2026-11-23T08:00:00.000Z" });
  const here = (await createAccountSession(d, { userId, email: "gone@example.test" })).token;
  const elsewhere = (await createAccountSession(d, { userId, email: "gone@example.test" })).token;
  const account = (await readAccountByToken(here, d))!;
  return { d, log, fixture, userId, backing, accounts, here, elsewhere, account };
}

describe("account deletion", () => {
  // Fails if any owned row or session survives, or the auth user is deleted before the data (a failure would orphan it).
  it("deletes the profile, saved reports and every session, and deletes the auth user last", async () => {
    const s = await signedIn();
    expect(await deleteAccount(s.d, s.account)).toBe("deleted");
    expect(s.log).toEqual(["auth.getUser", "accounts.deleteAccountData", "auth.deleteUser"]);
    expect(await s.accounts.getProfile(s.userId)).toBeNull();
    expect(await s.accounts.listSavedReports(s.userId)).toEqual([]);
    expect(await readAccountByToken(s.here, s.d)).toBeNull();
    expect(await readAccountByToken(s.elsewhere, s.d)).toBeNull();
    expect(s.fixture.userIdOf("gone@example.test")).toBeNull();
    expect([...s.d.backing.values.keys()].filter((k) => k.startsWith("account-session"))).toEqual([]);
  });

  // P3-R7. Fails if the account's list of analyses (the claim choices) outlives the account.
  it("deletes the account's list of analyses", async () => {
    const s = await signedIn();
    await indexAccountAnalyses(s.d, s.userId, ["a".repeat(32)]);
    expect([...s.d.backing.values.keys()]).toContain(`account-analyses:${s.userId}`);
    expect(await deleteAccount(s.d, s.account)).toBe("deleted");
    expect([...s.d.backing.values.keys()].filter((k) => k.startsWith("account-analyses:"))).toEqual([]);
  });

  // Fails if a provider outage deletes anything (the pre-check must run before every deletion).
  it("deletes nothing when the provider is unavailable", async () => {
    const s = await signedIn();
    s.fixture.fail("getUser");
    expect(await deleteAccount(s.d, s.account)).toBe("nothing_deleted");
    expect(s.log).toEqual(["auth.getUser"]);
    expect(await s.accounts.listSavedReports(s.userId)).toHaveLength(2);
    expect(await readAccountByToken(s.here, s.d)).not.toBeNull();
    expect(await readAccountByToken(s.elsewhere, s.d)).not.toBeNull();
    expect(s.fixture.userIdOf("gone@example.test")).toBe(s.userId);
  });

  // Fails if a failed data deletion is followed by deleting the auth user, or loses any saved data.
  it("keeps the data, the auth user and this session when the data deletion fails", async () => {
    const s = await signedIn({ failData: true });
    expect(await deleteAccount(s.d, s.account)).toBe("nothing_deleted");
    expect(s.log).toEqual(["auth.getUser", "accounts.deleteAccountData"]);
    expect(await s.accounts.getProfile(s.userId)).not.toBeNull();
    expect(await s.accounts.listSavedReports(s.userId)).toHaveLength(2);
    expect(s.fixture.userIdOf("gone@example.test")).toBe(s.userId);
    expect(await readAccountByToken(s.here, s.d)).not.toBeNull();
  });

  // Fails if a failed auth deletion signs the visitor out (no retry possible) or a retry cannot finish.
  it("reports a partial deletion when the auth user cannot be deleted, keeps this session, and a retry finishes", async () => {
    const s = await signedIn();
    s.fixture.fail("deleteUser");
    expect(await deleteAccount(s.d, s.account)).toBe("partial");
    expect(await s.accounts.listSavedReports(s.userId)).toEqual([]);
    expect(await readAccountByToken(s.here, s.d)).not.toBeNull();
    s.fixture.heal();
    expect(await deleteAccount(s.d, s.account)).toBe("deleted");
    expect(s.fixture.userIdOf("gone@example.test")).toBeNull();
    expect(await readAccountByToken(s.here, s.d)).toBeNull();
  });
});

describe("POST /api/account/delete", () => {
  const post = (body: string, cookie: string, o: { cross?: boolean } = {}) =>
    new Request(`${PUBLIC_ORIGIN}/api/account/delete`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie, "sec-fetch-site": o.cross ? "cross-site" : "same-origin" },
      body,
    });

  // Fails if deletion does not clear the cookie and show the deleted notice.
  it("deletes with the confirmation box ticked, clears the cookie and redirects to the deleted notice", async () => {
    const s = await signedIn();
    const res = await handleAccountDelete(post("confirm=yes", `${ACCOUNT_COOKIE}=${s.here}`), s.d);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`${PUBLIC_ORIGIN}/sign-in?account=deleted`);
    expect(res.headers.get("set-cookie")).toMatch(new RegExp(`^${ACCOUNT_COOKIE}=; .*Max-Age=0`));
    expect(await s.accounts.getProfile(s.userId)).toBeNull();
  });

  // Fails if an unticked box, another site's post or a signed-out request deletes anything.
  it("deletes nothing without the ticked box, from another site, or when signed out", async () => {
    const s = await signedIn();
    const unticked = await handleAccountDelete(post("", `${ACCOUNT_COOKIE}=${s.here}`), s.d);
    expect(unticked.headers.get("location")).toBe(`${PUBLIC_ORIGIN}/account?delete=confirm`);
    expect((await handleAccountDelete(post("confirm=yes", `${ACCOUNT_COOKIE}=${s.here}`, { cross: true }), s.d)).status).toBe(403);
    const signedOut = await handleAccountDelete(post("confirm=yes", ""), s.d);
    expect(signedOut.headers.get("location")).toBe(`${PUBLIC_ORIGIN}/sign-in?returnTo=%2Faccount`);
    expect(s.log).toEqual([]);
    expect(await s.accounts.listSavedReports(s.userId)).toHaveLength(2);
  });

  // Fails if a failure is hidden from the visitor or the visitor is signed out by it.
  it("redirects a failure to the account page with its notice and keeps the cookie", async () => {
    const s = await signedIn();
    s.fixture.fail("getUser");
    const res = await handleAccountDelete(post("confirm=yes", `${ACCOUNT_COOKIE}=${s.here}`), s.d);
    expect(res.headers.get("location")).toBe(`${PUBLIC_ORIGIN}/account?delete=failed`);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(await readAccount(new Request(PUBLIC_ORIGIN, { headers: { cookie: `${ACCOUNT_COOKIE}=${s.here}` } }), s.d)).not.toBeNull();
  });
});

describe("deletion failure text", () => {
  // Fails if the failure text says nothing was deleted although the account's other sessions may already be ended.
  it("says the data was not deleted and that other devices may be signed out", async () => {
    const s = await signedIn({ failData: true });
    expect(await deleteAccount(s.d, s.account)).toBe("nothing_deleted");
    expect(await readAccountByToken(s.elsewhere, s.d)).toBeNull();
    expect(ACCOUNT_TEXT.deleteFailed).toContain("Your data was not deleted");
    expect(ACCOUNT_TEXT.deleteFailed).toContain("you may have been signed out on other devices");
    expect(ACCOUNT_TEXT.deleteFailed).not.toContain("Nothing was deleted");
  });
});
