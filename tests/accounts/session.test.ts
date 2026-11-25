import { afterEach, describe, expect, it, vi } from "vitest";
import { ACCOUNT_SESSION_TTL_S, MAX_SESSIONS_PER_ACCOUNT, accountClearCookie, accountSetCookie, createAccountSession, readAccount } from "@/lib/accounts/session";
import { handleSignOut } from "@/lib/api/sign-out";
import { sha256Hex } from "@/lib/security/tokens";
import { ACCOUNT_COOKIE, fakeClock, postRequest, PUBLIC_ORIGIN, storeDump, TEST_ACCOUNT, testDeps } from "../helpers/server-deps";

const DAY = 86_400_000;
const ACCOUNT = TEST_ACCOUNT;
const withCookie = (token: string) => new Request(`${PUBLIC_ORIGIN}/account`, { headers: { cookie: `retrofit_visitor=${"a".repeat(32)}; ${ACCOUNT_COOKIE}=${token}` } });

afterEach(() => vi.restoreAllMocks());

describe("account session cookie", () => {
  // Fails if the cookie becomes readable by scripts, is sent on cross-site posts, is scoped to one path, or drops Secure on HTTPS.
  it("is HttpOnly, SameSite=Lax and Path=/, and Secure over HTTPS only", () => {
    const https = { publicOrigin: PUBLIC_ORIGIN };
    const http = { publicOrigin: "http://127.0.0.1:3010" };
    const secure = accountSetCookie("0".repeat(32), https, true).split("; ");
    expect(secure[0]).toBe(`${ACCOUNT_COOKIE}=${"0".repeat(32)}`);
    expect(secure).toEqual(expect.arrayContaining(["HttpOnly", "SameSite=Lax", "Path=/", "Secure"]));
    const plain = accountSetCookie("0".repeat(32), http, false).split("; ");
    expect(plain[0]).toBe(`retrofit_account=${"0".repeat(32)}`);
    expect(plain).not.toContain("Secure");
    // Deleting it needs the same attributes.
    expect(accountClearCookie(https, true).split("; ")).toEqual(expect.arrayContaining([`${ACCOUNT_COOKIE}=`, "Path=/", "Secure", "Max-Age=0"]));
  });

  // Strix 2026-11-25. Fails if another subdomain can sign this browser in to its account with a cookie for the parent domain
  // (such a cookie cannot have the __Host- prefix), or the cookie has an attribute that a browser refuses with that prefix.
  it("a cookie without the host lock does not sign in over HTTPS", async () => {
    const d = testDeps();
    const { token } = await createAccountSession(d, ACCOUNT);
    const planted = new Request(`${PUBLIC_ORIGIN}/account`, { headers: { cookie: `retrofit_account=${token}` } });
    expect(await readAccount(planted, d)).toBeNull();
    expect((await readAccount(withCookie(token), d))?.accountId).toBe(ACCOUNT.userId);
    expect(accountSetCookie(token, d.config, true)).not.toMatch(/domain=/i);
    const local = testDeps({ env: { PUBLIC_ORIGIN: "http://127.0.0.1:3010" } });
    const dev = await createAccountSession(local, ACCOUNT);
    expect(await readAccount(new Request("http://127.0.0.1:3010/account", { headers: { cookie: `retrofit_account=${dev.token}` } }), local)).not.toBeNull();
  });
});

describe("account sessions", () => {
  // Fails if the raw session id reaches the Store (a Store dump would then sign anyone in).
  it("stores only the SHA-256 of the session id, with the account id and email", async () => {
    const d = testDeps({ clock: fakeClock().clock });
    const { token } = await createAccountSession(d, ACCOUNT);
    const dump = storeDump(d.backing);
    expect(dump).not.toContain(token);
    expect(dump).toContain(sha256Hex(token));
    expect(await readAccount(withCookie(token), d)).toEqual({ accountId: ACCOUNT.userId, email: ACCOUNT.email, sessionHash: sha256Hex(token) });
  });

  // Fails if a malformed or unknown cookie is treated as signed in.
  it("reads no account for a missing, malformed or unknown cookie", async () => {
    const d = testDeps();
    expect(await readAccount(new Request(`${PUBLIC_ORIGIN}/account`), d)).toBeNull();
    expect(await readAccount(withCookie("not-a-token"), d)).toBeNull();
    expect(await readAccount(withCookie("f".repeat(32)), d)).toBeNull();
  });

  // Fails if the session expires 30 days after sign-in while in use (no sliding), or lives on unused past 30 days.
  it("slides: a session used within 30 days stays valid, an unused one ends after 30 days", async () => {
    const clock = fakeClock();
    const d = testDeps({ clock: clock.clock });
    const used = await createAccountSession(d, ACCOUNT);
    const idle = await createAccountSession(d, { ...ACCOUNT, userId: "5f1c2b8e-1d2a-4e55-9c3b-2a1b0c9d8e7f" });
    clock.advance(20 * DAY);
    expect(await readAccount(withCookie(used.token), d)).not.toBeNull();
    clock.advance(20 * DAY);
    expect(await readAccount(withCookie(used.token), d)).not.toBeNull();
    expect(await readAccount(withCookie(idle.token), d)).toBeNull();
    clock.advance(ACCOUNT_SESSION_TTL_S * 1000 + 1);
    expect(await readAccount(withCookie(used.token), d)).toBeNull();
  });

  // Fails if every signed-in request writes the session record (one write per day is enough to slide).
  it("refreshes the record at most once a day", async () => {
    const clock = fakeClock();
    let writes = 0;
    const d = testDeps({ clock: clock.clock, instrument: (op, key) => void (op === "compareAndSet" && key.startsWith("account-session:") && writes++) });
    const { token } = await createAccountSession(d, ACCOUNT);
    for (let i = 0; i < 5; i++) {
      clock.advance(60_000);
      await readAccount(withCookie(token), d);
    }
    expect(writes).toBe(0);
    clock.advance(DAY);
    await readAccount(withCookie(token), d);
    await readAccount(withCookie(token), d);
    expect(writes).toBe(1);
  });

  // Fails if an account can collect unlimited live sessions (account deletion could not find them all).
  it(`keeps at most ${MAX_SESSIONS_PER_ACCOUNT} sessions per account: a new sign-in ends the oldest`, async () => {
    const clock = fakeClock();
    const d = testDeps({ clock: clock.clock });
    const tokens: string[] = [];
    for (let i = 0; i <= MAX_SESSIONS_PER_ACCOUNT; i++) {
      clock.advance(1000);
      tokens.push((await createAccountSession(d, ACCOUNT)).token);
    }
    expect(await readAccount(withCookie(tokens[0]!), d)).toBeNull();
    for (const t of tokens.slice(1)) expect(await readAccount(withCookie(t), d)).not.toBeNull();
  });
});

describe("sign-out", () => {
  // Fails if sign-out leaves the session usable, keeps the cookie, or answers anything but a redirect home.
  it("deletes the session record, clears the cookie and redirects home", async () => {
    const d = testDeps();
    const { token } = await createAccountSession(d, ACCOUNT);
    const res = await handleSignOut(postRequest("/api/auth/sign-out", "", { cookie: `${ACCOUNT_COOKIE}=${token}` }), d);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`${PUBLIC_ORIGIN}/`);
    expect(res.headers.get("set-cookie")).toMatch(new RegExp(`^${ACCOUNT_COOKIE}=; .*Max-Age=0`));
    expect(await readAccount(withCookie(token), d)).toBeNull();
    expect(storeDump(d.backing)).not.toContain(sha256Hex(token));
  });

  // Fails if another site can sign a visitor out (a cross-site form post).
  it("refuses a cross-origin post and keeps the session", async () => {
    const d = testDeps();
    const { token } = await createAccountSession(d, ACCOUNT);
    const res = await handleSignOut(postRequest("/api/auth/sign-out", "", { cookie: `${ACCOUNT_COOKIE}=${token}`, fetchSite: "cross-site", origin: "https://evil.example" }), d);
    expect(res.status).toBe(403);
    expect(await readAccount(withCookie(token), d)).not.toBeNull();
  });
});
