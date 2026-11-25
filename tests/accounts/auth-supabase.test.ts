/**
 * The Supabase Auth gateway against recorded Supabase Auth answers (a fake fetch: the provider is
 * the one thing mocked). No database or network is needed; this file is a listed exception in
 * eslint-rules/no-supabase-in-tests.mjs. The real provider is probed in tests/db/auth.db.test.ts.
 */
import { createClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handleConfirm } from "@/lib/api/confirm";
import { handleSignIn } from "@/lib/api/sign-in";
import { AuthRateLimited, AuthUnavailable } from "@/lib/auth/gateway";
import { createSupabaseAuthGateway } from "@/lib/auth/supabase";
import { ACCOUNT_COOKIE, captureConsole, cookieFrom, postRequest, PUBLIC_ORIGIN, storeDump, testDeps } from "../helpers/server-deps";

const FAKE_ACCESS = "FAKE-ACCESS-TOKEN-must-never-leave-the-gateway";
const FAKE_REFRESH = "FAKE-REFRESH-TOKEN-must-never-leave-the-gateway";
const URL_ = "http://auth.supabase.test";
const USER_ID = "4f1c2b8e-1d2a-4e55-9c3b-2a1b0c9d8e7f";

interface Call {
  method: string;
  url: string;
  body: unknown;
}

type Answer = { status: number; body?: unknown } | Error;

function fakeProvider(answers: Record<string, Answer>) {
  const calls: Call[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ method, url, body: typeof init?.body === "string" ? JSON.parse(init.body) : null });
    const path = new URL(url).pathname;
    const answer = answers[`${method} ${path}`];
    if (!answer) return new Response(JSON.stringify({ code: "not_stubbed" }), { status: 404 });
    if (answer instanceof Error) throw answer;
    return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), {
      status: answer.status,
      headers: { "content-type": "application/json", "x-supabase-api-version": "2024-01-01" },
    });
  }) as typeof fetch;
  const admin = createClient(URL_, "service-role-test", { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: fetchFn } });
  const gateway = createSupabaseAuthGateway({ url: URL_, anonKey: "anon-test", admin, fetch: fetchFn });
  return { gateway, calls };
}

const session = {
  access_token: FAKE_ACCESS,
  refresh_token: FAKE_REFRESH,
  token_type: "bearer",
  expires_in: 3600,
  expires_at: 4_000_000_000,
  user: { id: USER_ID, aud: "authenticated", email: "Person@Example.test", app_metadata: {}, user_metadata: {}, created_at: "2026-11-23T10:00:00Z" },
};

let errors: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => errors.mockRestore());

describe("Supabase auth gateway", () => {
  // Fails if sign-in stops creating accounts for new addresses or drops the confirm page as the link target.
  it("signInWithOtp posts the address with create_user and the redirect target", async () => {
    const { gateway, calls } = fakeProvider({ "POST /auth/v1/otp": { status: 200, body: {} } });
    await gateway.signInWithOtp("person@example.test", "https://retrofit.test/auth/confirm");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toMatchObject({ email: "person@example.test", create_user: true });
    expect(new URL(calls[0]!.url).searchParams.get("redirect_to")).toBe("https://retrofit.test/auth/confirm");
  });

  // Fails if one refused address counts as an outage (anybody could then open the owner's alert), or a wrong key, a shared limit, a 5xx or a
  // transport failure does not.
  it.each([
    [{ status: 400, body: { code: "email_address_invalid", message: "x" } }, false],
    [{ status: 422, body: { code: "validation_failed", message: "x" } }, false],
    [{ status: 401, body: { message: "Invalid API key" } }, true],
    [{ status: 404, body: { message: "no Route matched" } }, true],
    [{ status: 422, body: { code: "email_provider_disabled", message: "x" } }, true],
    [{ status: 422, body: { code: "signup_disabled", message: "x" } }, true],
    [{ status: 403, body: { code: "no_authorization", message: "x" } }, true],
    [{ status: 500, body: { code: "unexpected_failure", message: "x" } }, true],
    [new TypeError("fetch failed"), true],
  ] as [Answer, boolean][])("signInWithOtp: %j is an outage: %s", async (answer, outage) => {
    const failed = await fakeProvider({ "POST /auth/v1/otp": answer }).gateway.signInWithOtp("a@example.test", "https://r.test/auth/confirm").catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(AuthUnavailable);
    expect((failed as AuthUnavailable).outage).toBe(outage);
  });

  it("verifyOtp: a used-up shared limit is an outage", async () => {
    const failed = await fakeProvider({ "POST /auth/v1/verify": { status: 429, body: { code: "over_request_rate_limit", message: "x" } } }).gateway.verifyOtp("h", "email").catch((e: unknown) => e);
    expect((failed as AuthUnavailable).outage).toBe(true);
  });

  // Fails if a provider refusal to send again is reported as an outage, or an outage as success.
  it("signInWithOtp maps 429 to AuthRateLimited and every other failure to AuthUnavailable", async () => {
    await expect(fakeProvider({ "POST /auth/v1/otp": { status: 429, body: { code: "over_email_send_rate_limit", message: "x" } } }).gateway.signInWithOtp("a@example.test", "https://r.test/auth/confirm")).rejects.toBeInstanceOf(AuthRateLimited);
    await expect(fakeProvider({ "POST /auth/v1/otp": { status: 500, body: { code: "unexpected_failure", message: "smtp" } } }).gateway.signInWithOtp("a@example.test", "https://r.test/auth/confirm")).rejects.toBeInstanceOf(AuthUnavailable);
    await expect(fakeProvider({ "POST /auth/v1/otp": new TypeError("fetch failed") }).gateway.signInWithOtp("a@example.test", "https://r.test/auth/confirm")).rejects.toBeInstanceOf(AuthUnavailable);
  });

  // P2-R2. Fails if the per-address resend wait and the project-wide email limit are not told apart (one has a
  // known wait, the other does not), or the wait seconds are lost.
  it("signInWithOtp tells the per-address resend wait from the project-wide email limit", async () => {
    const wait = fakeProvider({ "POST /auth/v1/otp": { status: 429, body: { code: "over_email_send_rate_limit", message: "For security purposes, you can only request this after 42 seconds." } } });
    const perAddress = await wait.gateway.signInWithOtp("a@example.test", "https://r.test/auth/confirm").catch((e: unknown) => e);
    expect(perAddress).toBeInstanceOf(AuthRateLimited);
    expect(perAddress).toMatchObject({ scope: "address", retryAfterSeconds: 42 });
    const busy = fakeProvider({ "POST /auth/v1/otp": { status: 429, body: { code: "over_email_send_rate_limit", message: "Email rate limit exceeded" } } });
    expect(await busy.gateway.signInWithOtp("a@example.test", "https://r.test/auth/confirm").catch((e: unknown) => e)).toMatchObject({ scope: "project" });
  });

  // Fails if verifyOtp returns, or lets anything log, the provider's access or refresh token.
  it("verifyOtp answers only the user id and the lower-case email, and drops the session tokens", async () => {
    const { gateway, calls } = fakeProvider({ "POST /auth/v1/verify": { status: 200, body: session } });
    const result = await gateway.verifyOtp("abc123hash", "email");
    expect(result).toEqual({ ok: true, userId: USER_ID, email: "person@example.test" });
    expect(calls[0]!.body).toMatchObject({ token_hash: "abc123hash", type: "email" });
    expect(JSON.stringify(result)).not.toContain("FAKE-");
    expect(JSON.stringify(errors.mock.calls)).not.toContain("FAKE-");
  });

  // Fails if an expired or used link is reported as an outage (the visitor would not get the send-again form).
  it("verifyOtp answers expired for a 4xx answer and throws AuthUnavailable for a 5xx or a transport failure", async () => {
    const expired = fakeProvider({ "POST /auth/v1/verify": { status: 403, body: { code: "otp_expired", message: "Email link is invalid or has expired" } } });
    expect(await expired.gateway.verifyOtp("used", "email")).toEqual({ ok: false, reason: "expired" });
    await expect(fakeProvider({ "POST /auth/v1/verify": { status: 503, body: { message: "down" } } }).gateway.verifyOtp("h", "email")).rejects.toBeInstanceOf(AuthUnavailable);
    await expect(fakeProvider({ "POST /auth/v1/verify": new TypeError("fetch failed") }).gateway.verifyOtp("h", "email")).rejects.toBeInstanceOf(AuthUnavailable);
    expect(errors.mock.calls.map((c: unknown[]) => String(c[0]))).toEqual(["[AUTH_UNAVAILABLE] auth verifyOtp failed (http_503)", "[AUTH_UNAVAILABLE] auth verifyOtp failed (request_failed)"]);
  });

  // Fails if deletion reports a provider outage as done, or a user already deleted as a failure (a retry would never finish).
  it("deleteUser deletes through the admin API, counts a missing user as deleted, and throws AuthUnavailable on failure", async () => {
    const user = { status: 200, body: session.user };
    const ok = fakeProvider({ [`GET /auth/v1/admin/users/${USER_ID}`]: user, [`DELETE /auth/v1/admin/users/${USER_ID}`]: { status: 200, body: {} } });
    await ok.gateway.deleteUser(USER_ID);
    expect(ok.calls.map((c) => c.method)).toEqual(["GET", "DELETE"]);
    await fakeProvider({ [`GET /auth/v1/admin/users/${USER_ID}`]: { status: 404, body: { code: "user_not_found", message: "User not found" } } }).gateway.deleteUser(USER_ID);
    await expect(fakeProvider({ [`GET /auth/v1/admin/users/${USER_ID}`]: user, [`DELETE /auth/v1/admin/users/${USER_ID}`]: { status: 500, body: { message: "x" } } }).gateway.deleteUser(USER_ID)).rejects.toBeInstanceOf(AuthUnavailable);
  });

  // Fails if the deletion pre-check cannot tell a missing user from an outage.
  it("getUser answers the account, null for a missing user, and throws AuthUnavailable on failure", async () => {
    const path = `GET /auth/v1/admin/users/${USER_ID}`;
    expect(await fakeProvider({ [path]: { status: 200, body: session.user } }).gateway.getUser(USER_ID)).toEqual({ userId: USER_ID, email: "person@example.test" });
    expect(await fakeProvider({ [path]: { status: 404, body: { code: "user_not_found", message: "x" } } }).gateway.getUser(USER_ID)).toBeNull();
    await expect(fakeProvider({ [path]: new TypeError("fetch failed") }).gateway.getUser(USER_ID)).rejects.toBeInstanceOf(AuthUnavailable);
    expect(await fakeProvider({}).gateway.getUser("not-a-uuid")).toBeNull();
  });

  // P5-R1. Fails if anything but the provider's own "user not found" reads as a deleted account: a wrong URL, a proxy's 404, a new
  // project or a changed answer would make every account look gone.
  it.each([
    ["a 404 without a code", { status: 404, body: { message: "not found" } }],
    ["a 404 with another code", { status: 404, body: { code: "not_stubbed", message: "x" } }],
    ["a 404 with the code in another case", { status: 404, body: { code: "USER_NOT_FOUND", message: "x" } }],
    ["a 404 that is not JSON", { status: 404 }],
    ["user_not_found with another status", { status: 400, body: { code: "user_not_found", message: "x" } }],
    ["a 200 with an empty object", { status: 200, body: {} }],
    ["a 200 with null", { status: 200, body: null }],
    ["a 200 with a list", { status: 200, body: [] }],
    ["a 200 without an email", { status: 200, body: { id: USER_ID } }],
    ["a 200 with an empty email", { status: 200, body: { id: USER_ID, email: "" } }],
    ["a 200 for another user", { status: 200, body: { id: "5f1c2b8e-1d2a-4e55-9c3b-2a1b0c9d8e7f", email: "x@example.test" } }],
    ["a 401", { status: 401, body: { code: "no_authorization", message: "x" } }],
    ["a 403", { status: 403, body: { code: "not_admin", message: "x" } }],
    ["a 429", { status: 429, body: { code: "over_request_rate_limit", message: "x" } }],
    ["a 500", { status: 500, body: { code: "user_not_found", message: "x" } }],
  ])("getUser throws AuthUnavailable for %s", async (_name, answer) => {
    await expect(fakeProvider({ [`GET /auth/v1/admin/users/${USER_ID}`]: answer }).gateway.getUser(USER_ID)).rejects.toBeInstanceOf(AuthUnavailable);
  });

  // P5-R1. Fails if a deletion that a wrong URL or a proxy answered with 404 counts as done: the auth user would live on.
  it.each([
    ["a 404 without a code", { status: 404, body: { message: "not found" } }],
    ["a 404 with another code", { status: 404, body: { code: "not_stubbed", message: "x" } }],
  ])("deleteUser throws AuthUnavailable for %s", async (_name, answer) => {
    const user = { status: 200, body: session.user };
    await expect(fakeProvider({ [`GET /auth/v1/admin/users/${USER_ID}`]: user, [`DELETE /auth/v1/admin/users/${USER_ID}`]: answer }).gateway.deleteUser(USER_ID)).rejects.toBeInstanceOf(AuthUnavailable);
    await expect(fakeProvider({ [`GET /auth/v1/admin/users/${USER_ID}`]: answer }).gateway.deleteUser(USER_ID)).rejects.toBeInstanceOf(AuthUnavailable);
  });
});

describe("Supabase tokens never leave the gateway", () => {
  // Fails if Supabase's access or refresh token reaches a sign-in or confirm response header or body, the Store,
  // the account data or a console line.
  it("keeps the provider's access and refresh tokens out of every header, body, Store value and console line", async () => {
    const { gateway: auth } = fakeProvider({ "POST /auth/v1/otp": { status: 200, body: {} }, "POST /auth/v1/verify": { status: 200, body: session } });
    const lines: string[] = [];
    errors.mockRestore();
    captureConsole(lines);
    const d = testDeps({ auth });
    const visitor = `retrofit_visitor=${"a".repeat(32)}`;
    const sent = await handleSignIn(postRequest("/api/auth/sign-in", { email: "person@example.test" }, { cookie: visitor }), d);
    const res = await handleConfirm(
      new Request(`${PUBLIC_ORIGIN}/auth/verify`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "same-origin", cookie: `${visitor}; ${cookieFrom(sent)}` },
        body: "token_hash=0123456789abcdef0123456789abcdef&type=email",
      }),
      d,
    );
    expect(res.status).toBe(303);
    expect(res.headers.getSetCookie().some((c: string) => c.startsWith(`${ACCOUNT_COOKIE}=`))).toBe(true);
    const seen = [...sent.headers.entries(), ...res.headers.entries()].flat().join("\n") + (await sent.text()) + (await res.text()) + storeDump(d.backing) + lines.join("\n") + JSON.stringify([...d.accountsBacking.profiles]);
    for (const token of [FAKE_ACCESS, FAKE_REFRESH, "FAKE-"]) expect(seen).not.toContain(token);
  });
});
