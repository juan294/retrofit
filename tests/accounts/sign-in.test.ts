import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_RETURN, safeReturnTo } from "@/lib/accounts/return-to";
import { SIGN_IN_COOKIE, handleSignIn } from "@/lib/api/sign-in";
import { SIGN_IN_TEXT } from "@/lib/site/sign-in-texts";
import { captureConsole, fakeClock, PUBLIC_ORIGIN, postRequest, storeDump, testDeps } from "../helpers/server-deps";

const signIn = (body: unknown, o: Parameters<typeof postRequest>[2] = {}) => postRequest("/api/auth/sign-in", body, o);
// 10:20 UTC (fakeClock's start): the hourly windows end at 11:00 UTC.
const WINDOW_END = "2026-11-15T11:00:00.000Z";

afterEach(() => vi.restoreAllMocks());

describe("POST /api/auth/sign-in", () => {
  // Fails if the answer tells whether an address already has an account (status, body or cookie shape).
  it("gives the same answer for a known and an unknown address", async () => {
    const d = testDeps({ clock: fakeClock().clock });
    await d.auth.signInWithOtp("known@example.test", `${PUBLIC_ORIGIN}/auth/confirm`);
    const known = await handleSignIn(signIn({ email: "known@example.test" }, { ip: "203.0.113.1" }), d);
    const unknown = await handleSignIn(signIn({ email: "new@example.test" }, { ip: "203.0.113.2" }), d);
    expect([known.status, unknown.status]).toEqual([200, 200]);
    expect(await known.json()).toEqual(await unknown.json());
    expect(known.headers.get("set-cookie")?.replace(/=[0-9a-f]{32}/, "=x")).toBe(unknown.headers.get("set-cookie")?.replace(/=[0-9a-f]{32}/, "=x"));
    expect(d.fixtureAuth.latestLink("new@example.test")).toMatch(/\/auth\/confirm\?token_hash=/);
  });

  // Fails if the provider receives a redirect target other than Retrofit's own confirm route.
  it("asks the provider for a link to PUBLIC_ORIGIN/auth/confirm whatever returnTo says", async () => {
    const d = testDeps();
    await handleSignIn(signIn({ email: "a@example.test", returnTo: "https://evil.example/" }), d);
    expect(d.fixtureAuth.sent.map((s) => s.redirectTo)).toEqual([`${PUBLIC_ORIGIN}/auth/confirm`]);
  });

  // Fails if the per-network limit is missing, counts wrong, or the 429 lacks the window's end.
  it("limits one network to 5 links an hour and answers 429 with retryAt", async () => {
    const d = testDeps({ clock: fakeClock().clock });
    for (let i = 0; i < 5; i++) expect((await handleSignIn(signIn({ email: `n${i}@example.test` }), d)).status).toBe(200);
    const refused = await handleSignIn(signIn({ email: "n6@example.test" }), d);
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({ error: "limit", message: SIGN_IN_TEXT.limit(new Date(WINDOW_END)), retryAt: WINDOW_END });
    expect(d.fixtureAuth.latestLink("n6@example.test")).toBeNull();
  });

  // Fails if one address can be sent more than 3 links an hour by spreading the requests over networks.
  it("limits one address to 3 links an hour across networks, in any letter case", async () => {
    const d = testDeps({ clock: fakeClock().clock });
    for (let i = 0; i < 3; i++) expect((await handleSignIn(signIn({ email: i === 1 ? "Target@Example.test" : "target@example.test" }, { ip: `198.51.100.${i}` }), d)).status).toBe(200);
    const refused = await handleSignIn(signIn({ email: "target@example.test" }, { ip: "198.51.100.9" }), d);
    expect(refused.status).toBe(429);
    expect(((await refused.json()) as { retryAt: string }).retryAt).toBe(WINDOW_END);
    expect(d.fixtureAuth.sent).toHaveLength(3);
  });

  // Fails if the raw address is used as a Store key or value, or reaches a log line.
  it("keeps the address out of the Store and the logs", async () => {
    const lines: string[] = [];
    captureConsole(lines);
    const d = testDeps();
    await handleSignIn(signIn({ email: "private.person@example.test" }), d);
    d.fixtureAuth.fail("signInWithOtp");
    await handleSignIn(signIn({ email: "private.person@example.test" }), d);
    expect(storeDump(d.backing)).not.toContain("private.person");
    expect(lines.join("\n")).not.toContain("private.person");
  });

  // Fails if a provider failure is reported as success, or the visitor loses the fallback address.
  it("answers 503 with the mail-unavailable text when the provider cannot send", async () => {
    const d = testDeps();
    d.fixtureAuth.fail("signInWithOtp");
    const res = await handleSignIn(signIn({ email: "a@example.test" }), d);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "mail_unavailable", message: "We could not send the sign-in email. Try again later, or email retrofit@thecreativetoken.com." });
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  // Fails if the provider's own resend limit is shown as an outage instead of a short wait.
  it("answers 429 with a one-minute wait when the provider refuses to send again so soon", async () => {
    const clock = fakeClock();
    const d = testDeps({ clock: clock.clock });
    d.fixtureAuth.fail("signInWithOtp", "rate_limited");
    const res = await handleSignIn(signIn({ email: "a@example.test" }), d);
    expect(res.status).toBe(429);
    const retryAt = new Date(clock.now() + 60_000);
    expect(await res.json()).toEqual({ error: "wait", message: SIGN_IN_TEXT.wait(retryAt), retryAt: retryAt.toISOString() });
  });

  // Fails if another site can make Retrofit email people, or a bad body reaches the provider.
  it("refuses a cross-origin post, an invalid address and a large body before sending anything", async () => {
    const d = testDeps();
    expect((await handleSignIn(signIn({ email: "a@example.test" }, { fetchSite: "cross-site", origin: "https://evil.example" }), d)).status).toBe(403);
    const bad = await handleSignIn(signIn({ email: "not an email" }), d);
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "invalid_email", message: SIGN_IN_TEXT.invalidEmail });
    expect((await handleSignIn(signIn("{not json"), d)).status).toBe(400);
    expect((await handleSignIn(signIn({ email: `${"a".repeat(3000)}@example.test` }), d)).status).toBe(413);
    expect(d.fixtureAuth.calls).toEqual([]);
  });

  // Fails if the browser that asked is not marked (confirm would attach analyses for any browser that opens the link).
  it("marks the asking browser with an HttpOnly cookie scoped to /auth for one hour", async () => {
    const d = testDeps();
    const res = await handleSignIn(signIn({ email: "a@example.test", returnTo: "/r/0123" }), d);
    const cookie = (res.headers.get("set-cookie") ?? "").split("; ");
    expect(cookie[0]).toMatch(new RegExp(`^${SIGN_IN_COOKIE}=[0-9a-f]{32}$`));
    expect(cookie).toEqual(expect.arrayContaining(["HttpOnly", "SameSite=Lax", "Path=/auth", "Max-Age=3600", "Secure"]));
  });
});

describe("returnTo", () => {
  // Fails if any form of another origin, a scheme, a protocol-relative or backslash path, or a control character passes.
  it.each([
    ["https://evil.example/r/x"],
    ["//evil.example/r/x"],
    ["/\\evil.example"],
    ["\\\\evil.example"],
    ["javascript:alert(1)"],
    ["/r/x\nSet-Cookie: a=b"],
    ["/r/\u0000x"],
    ["r/relative"],
    ["/api/account/delete"],
    ["/auth/confirm?token_hash=x"],
    [""],
    [`/${"a".repeat(600)}`],
  ])("refuses %j and falls back to /account", (raw) => {
    expect(safeReturnTo(raw)).toBe(DEFAULT_RETURN);
    expect(DEFAULT_RETURN).toBe("/account");
  });

  // Fails if a same-origin page the visitor started from is not kept (with its query).
  it.each([["/r/0123456789abcdef0123456789abcdef"], ["/account"], ["/pricing?plan=pro"]])("keeps %j", (raw) => {
    expect(safeReturnTo(raw)).toBe(raw);
  });

  it("refuses a value that is not a string", () => {
    expect(safeReturnTo(undefined)).toBe(DEFAULT_RETURN);
    expect(safeReturnTo(["/r/x"])).toBe(DEFAULT_RETURN);
  });
});
