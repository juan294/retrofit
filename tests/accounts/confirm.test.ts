import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConfirmSignInForm } from "@/components/ConfirmSignInForm";
import { ACCOUNT_COOKIE, createAccountSession, readAccount, readAccountByToken } from "@/lib/accounts/session";
import { getAnalysis } from "@/lib/analysis/record";
import { handleAnalyze } from "@/lib/api/analyze";
import { confirmPageState, handleConfirm } from "@/lib/api/confirm";
import { SIGN_IN_COOKIE, handleSignIn } from "@/lib/api/sign-in";
import { SIGN_IN_TEXT } from "@/lib/site/sign-in-texts";
import { analyzeRequest, fakeClock, holdAllSlots, PUBLIC_ORIGIN, postRequest, testDeps, type TestDeps } from "../helpers/server-deps";

const VISITOR = `retrofit_visitor=${"a".repeat(32)}`;
const OTHER_VISITOR = `retrofit_visitor=${"b".repeat(32)}`;

/** The cookie values of every Set-Cookie header, by name. */
function setCookies(res: Response): Record<string, string> {
  return Object.fromEntries(res.headers.getSetCookie().map((c) => [c.slice(0, c.indexOf("=")), c]));
}
const valueOf = (setCookie: string | undefined) => setCookie?.split(";")[0]?.split("=")[1] ?? "";

/** Asks for a link as `visitor` and returns the emailed link and the sign-in cookie. */
async function askForLink(d: TestDeps, email: string, o: { visitor?: string; returnTo?: string } = {}) {
  const res = await handleSignIn(postRequest("/api/auth/sign-in", { email, returnTo: o.returnTo }, { cookie: o.visitor }), d);
  expect(res.status).toBe(200);
  const link = d.fixtureAuth.latestLink(email);
  if (!link) throw new Error("no link sent");
  return { link, signIn: `${SIGN_IN_COOKIE}=${valueOf(setCookies(res)[SIGN_IN_COOKIE])}` };
}

/** The confirm page's "Sign in" form post for `link` (its token_hash and type in the urlencoded body). */
function confirmPost(link: string, cookie?: string, o: { cross?: boolean } = {}): Request {
  const headers = new Headers({ "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": o.cross ? "cross-site" : "same-origin" });
  if (o.cross) headers.set("origin", "https://evil.example");
  if (cookie) headers.set("cookie", cookie);
  return new Request(`${PUBLIC_ORIGIN}/auth/verify`, { method: "POST", headers, body: new URL(link).search.slice(1) });
}
const open = (d: TestDeps, link: string, cookie?: string) => handleConfirm(confirmPost(link, cookie), d);

async function startAnalysis(d: TestDeps, cookie: string): Promise<string> {
  const res = await handleAnalyze(analyzeRequest({ url: "https://bakery.example.com" }, { cookie }), d);
  return ((await res.json()) as { id: string }).id;
}

afterEach(() => vi.restoreAllMocks());

describe("POST /auth/verify (the confirm page's Sign in button)", () => {
  // Fails if a confirmed link does not sign in (cookie, session), return to the starting page, or attach the visitor's analyses.
  it("sets retrofit_account, returns to the page sign-in started from and attaches the visitor's analyses", async () => {
    const d = testDeps({ clock: fakeClock().clock });
    await holdAllSlots(d);
    const ids = [await startAnalysis(d, VISITOR), await startAnalysis(d, VISITOR)];
    const { link, signIn } = await askForLink(d, "person@example.test", { visitor: VISITOR, returnTo: `/r/${ids[0]}` });

    const res = await open(d, link, `${VISITOR}; ${signIn}`);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`${PUBLIC_ORIGIN}/r/${ids[0]}`);
    const cookies = setCookies(res);
    expect(cookies[ACCOUNT_COOKIE]?.split("; ")).toEqual(expect.arrayContaining(["HttpOnly", "SameSite=Lax", "Path=/", "Secure"]));
    expect(cookies[SIGN_IN_COOKIE]).toMatch(/Max-Age=0/);

    const account = await readAccount(new Request(PUBLIC_ORIGIN, { headers: { cookie: `${ACCOUNT_COOKIE}=${valueOf(cookies[ACCOUNT_COOKIE])}` } }), d);
    expect(account?.email).toBe("person@example.test");
    expect(account?.accountId).toBe(d.fixtureAuth.userIdOf("person@example.test"));
    for (const id of ids) {
      const a = await getAnalysis(d.store, id);
      expect(a?.accountId).toBe(account?.accountId);
      expect(a?.ownerHash).toEqual(expect.any(String));
    }
    expect(await d.accounts.getProfile(account!.accountId)).not.toBeNull();
  });

  // Fails if another visitor's analyses are attached, or analyses are attached for a link opened in a browser that did not ask for it.
  it("attaches nothing and returns to /account when the browser that opens the link did not ask for it", async () => {
    const d = testDeps({ clock: fakeClock().clock });
    await holdAllSlots(d);
    const mine = await startAnalysis(d, OTHER_VISITOR);
    const { link } = await askForLink(d, "person@example.test", { visitor: VISITOR, returnTo: "/pricing" });
    const res = await open(d, link, OTHER_VISITOR);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`${PUBLIC_ORIGIN}/account`);
    expect(setCookies(res)[ACCOUNT_COOKIE]).toBeDefined();
    expect((await getAnalysis(d.store, mine))?.accountId).toBeUndefined();
  });

  // Fails if a link for one address attaches analyses when the browser asked for a different address (a link sent by someone else).
  it("attaches nothing when the browser asked for a link to a different address", async () => {
    const d = testDeps({ clock: fakeClock().clock });
    await holdAllSlots(d);
    const mine = await startAnalysis(d, VISITOR);
    const { signIn } = await askForLink(d, "victim@example.test", { visitor: VISITOR });
    const { link: attackerLink } = await askForLink(d, "attacker@example.test", { visitor: OTHER_VISITOR });
    const res = await open(d, attackerLink, `${VISITOR}; ${signIn}`);
    expect(res.headers.get("location")).toBe(`${PUBLIC_ORIGIN}/account`);
    expect((await getAnalysis(d.store, mine))?.accountId).toBeUndefined();
  });

  // Fails if an expired link signs in, or the visitor does not reach the send-again page.
  it("sends an expired link to the expired page without signing in", async () => {
    const clock = fakeClock();
    const d = testDeps({ clock: clock.clock });
    const { link, signIn } = await askForLink(d, "late@example.test", { visitor: VISITOR });
    clock.advance(3600 * 1000);
    const res = await open(d, link, `${VISITOR}; ${signIn}`);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`${PUBLIC_ORIGIN}/sign-in?link=expired`);
    expect(setCookies(res)[ACCOUNT_COOKIE]).toBeUndefined();
  });

  // Fails if a used link signs in a second time (a forwarded or scanned link would open the account).
  it("sends a reused link to the expired page and keeps the first session", async () => {
    const d = testDeps();
    const { link, signIn } = await askForLink(d, "once@example.test", { visitor: VISITOR });
    const first = await open(d, link, `${VISITOR}; ${signIn}`);
    expect(setCookies(first)[ACCOUNT_COOKIE]).toBeDefined();
    const second = await open(d, link, VISITOR);
    expect(second.headers.get("location")).toBe(`${PUBLIC_ORIGIN}/sign-in?link=expired`);
    expect(setCookies(second)[ACCOUNT_COOKIE]).toBeUndefined();
    const account = await readAccount(new Request(PUBLIC_ORIGIN, { headers: { cookie: `${ACCOUNT_COOKIE}=${valueOf(setCookies(first)[ACCOUNT_COOKIE])}` } }), d);
    expect(account?.email).toBe("once@example.test");
  });

  // Fails if a malformed query reaches the provider, or is not shown the send-again page.
  it.each([["?type=email"], ["?token_hash=abc&type=magiclink"], ["?token_hash=%3Cscript%3E&type=email"], [""]])("sends the malformed query %j to the expired page without asking the provider", async (query) => {
    const d = testDeps();
    const res = await open(d, `${PUBLIC_ORIGIN}/auth/confirm${query}`);
    expect(res.headers.get("location")).toBe(`${PUBLIC_ORIGIN}/sign-in?link=expired`);
    expect(d.fixtureAuth.calls).toEqual([]);
  });

  // Fails if a provider outage is shown as an expired link (the visitor would ask for links that cannot be checked).
  it("sends a provider outage to the unavailable page without signing in", async () => {
    const d = testDeps();
    const { link } = await askForLink(d, "a@example.test");
    d.fixtureAuth.fail("verifyOtp");
    const res = await open(d, link);
    expect(res.headers.get("location")).toBe(`${PUBLIC_ORIGIN}/sign-in?link=unavailable`);
    expect(setCookies(res)[ACCOUNT_COOKIE]).toBeUndefined();
  });

  // Fails if the confirm answer is cacheable or leaks the token through the Referer of the next page.
  it("answers no-store with no referrer", async () => {
    const d = testDeps();
    const { link } = await askForLink(d, "a@example.test");
    const res = await open(d, link);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });
});

describe("sign-in confirm page review repairs", () => {
  // P2-R1. Fails if another site can post a stolen or attacker link to sign a visitor in (login CSRF), or the provider is asked.
  it("refuses a cross-origin post before asking the provider", async () => {
    const d = testDeps();
    const { link, signIn } = await askForLink(d, "a@example.test", { visitor: VISITOR });
    const res = await handleConfirm(confirmPost(link, `${VISITOR}; ${signIn}`, { cross: true }), d);
    expect(res.status).toBe(403);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(d.fixtureAuth.calls).toEqual(["signInWithOtp"]);
    expect(setCookies(await open(d, link, `${VISITOR}; ${signIn}`))[ACCOUNT_COOKIE]).toBeDefined();
  });

  // P2-R1. Fails if the page that the emailed link opens would verify the link itself (mail scanners would use it up).
  it("the confirm page state needs no provider and offers the button only for a well-formed link", () => {
    const hash = "0123456789abcdef0123456789abcdef";
    expect(confirmPageState({ token_hash: hash, type: "email" }, true)).toEqual({ kind: "confirm", tokenHash: hash, type: "email", otherBrowser: false });
    expect(confirmPageState({ token_hash: hash, type: "email" }, false)).toEqual({ kind: "confirm", tokenHash: hash, type: "email", otherBrowser: true });
    for (const bad of [{ type: "email" }, { token_hash: hash, type: "magiclink" }, { token_hash: "<script>", type: "email" }, { token_hash: [hash, hash], type: "email" }]) {
      expect(confirmPageState(bad, true)).toEqual({ kind: "invalid" });
    }
  });

  // P2-R1. Fails if the form can submit as GET before hydration, loses the token, or hides the other-browser warning.
  it("the confirm form posts the token to /auth/verify with its button disabled until hydration, and warns for another browser", () => {
    const render = (otherBrowser: boolean) => renderToStaticMarkup(createElement(ConfirmSignInForm, { tokenHash: "abc0123456789abcdef", type: "email", otherBrowser }));
    const html = render(true);
    const form = /<form[^>]*>/.exec(html)?.[0] ?? "";
    expect(form).toMatch(/method="post"/);
    expect(form).toMatch(/action="\/auth\/verify"/);
    expect(html).toMatch(/<input[^>]*name="token_hash"[^>]*value="abc0123456789abcdef"/);
    expect(html).toMatch(/<input[^>]*name="type"[^>]*value="email"/);
    expect(/<button[^>]*type="submit"[^>]*>/.exec(html)?.[0]).toMatch(/disabled=""/);
    const warning = SIGN_IN_TEXT.otherBrowser.replaceAll("'", "&#x27;");
    expect(html).toContain(warning);
    expect(render(false)).not.toContain(warning);
  });

  // P2-R4. Fails if signing in on a browser that already has a session leaves that older session usable.
  it("ends the browser's current session before issuing the new one", async () => {
    const d = testDeps();
    const old = (await createAccountSession(d, { userId: "5f1c2b8e-1d2a-4e55-9c3b-2a1b0c9d8e7f", email: "previous@example.test" })).token;
    const { link, signIn } = await askForLink(d, "next@example.test", { visitor: VISITOR });
    const res = await open(d, link, `${VISITOR}; ${signIn}; ${ACCOUNT_COOKIE}=${old}`);
    expect(setCookies(res)[ACCOUNT_COOKIE]).toBeDefined();
    expect(await readAccountByToken(old, d)).toBeNull();
    expect((await readAccountByToken(valueOf(setCookies(res)[ACCOUNT_COOKIE]), d))?.email).toBe("next@example.test");
  });
});
