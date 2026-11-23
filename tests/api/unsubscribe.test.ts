import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AccountDataUnavailable, hashToken, oneClickUnsubscribeUrl, type AccountData } from "@/lib/accounts/data";
import { createMemoryAccountData } from "@/lib/accounts/memory";
import { handleUnsubscribePost, UNSUBSCRIBE_MAX_BODY_BYTES, unsubscribeByToken, unsubscribePageState } from "@/lib/api/unsubscribe";
import { getAccountData } from "@/lib/server/runtime";
import UnsubscribePage from "@/app/unsubscribe/page";
import { captureConsole, PUBLIC_ORIGIN, testDeps } from "../helpers/server-deps";

const UNKNOWN = "0123456789abcdef0123456789abcdef";

/** A browser form submission from the confirm page: `t` in the urlencoded body. */
function formPost(fields: Record<string, string>, o: { query?: string; origin?: string; contentType?: string; body?: string } = {}): Request {
  const headers = new Headers({ "content-type": o.contentType ?? "application/x-www-form-urlencoded" });
  if (o.origin) headers.set("origin", o.origin);
  return new Request(`${PUBLIC_ORIGIN}/api/unsubscribe${o.query ?? ""}`, { method: "POST", headers, body: o.body ?? new URLSearchParams(fields).toString() });
}

/** An RFC 8058 one-click request from a mail provider: cross-site, token in the query. */
const oneClick = (token: string) => formPost({ "List-Unsubscribe": "One-Click" }, { query: `?t=${token}`, origin: "https://mail.provider.example" });

async function signup(d: ReturnType<typeof testDeps>, email: string): Promise<string> {
  const { unsubscribeToken } = await d.accounts.addNotifySignup(email, true);
  return unsubscribeToken as string;
}

describe("unsubscribeByToken", () => {
  // Fails if the token does not unsubscribe its own address, or a second call changes the recorded time or the answer.
  it("unsubscribes once and gives the same answer on a second call", async () => {
    const d = testDeps();
    const token = await signup(d, "leave@example.test");
    expect(await unsubscribeByToken(token, d.accounts)).toBe("done");
    const first = d.accountsBacking.notify.get("leave@example.test")?.unsubscribedAt;
    expect(first).toEqual(expect.any(Number));
    expect(await unsubscribeByToken(token, d.accounts)).toBe("done");
    expect(d.accountsBacking.notify.get("leave@example.test")?.unsubscribedAt).toBe(first);
  });

  // Fails if an unknown, malformed, repeated or missing token unsubscribes anything or answers like a valid link.
  it.each([[undefined], [""], [UNKNOWN], ["../etc"], [["a", "b"]], ["0123456789ABCDEF0123456789ABCDEF"]])("answers invalid for %j", async (t) => {
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

describe("GET /unsubscribe?t=<token>", () => {
  // Fails if opening the link changes anything: mail link scanners open every link in a message.
  it("renders the confirm form and does not unsubscribe", async () => {
    const accounts = getAccountData();
    const email = `scanner-${Date.now()}@example.test`;
    const token = (await accounts.addNotifySignup(email, false)).unsubscribeToken as string;
    const html = renderToStaticMarkup(await UnsubscribePage({ searchParams: Promise.resolve({ t: token }) }));
    const form = /<form[^>]*>/.exec(html)?.[0] ?? "";
    expect(form).toMatch(/method="post"/);
    expect(form).toMatch(/action="\/api\/unsubscribe"/);
    expect(html).toContain(`name="t" value="${token}"`);
    expect((await accounts.findNotifySignup(email))?.unsubscribedAt).toBeNull();
    expect(await accounts.unsubscribe(hashToken(token))).toBe("unsubscribed");
  });

  // Fails if the result page shows anything but the fixed text for a fixed outcome.
  it("renders the result text with no form", async () => {
    const html = renderToStaticMarkup(createElement("div", null, await UnsubscribePage({ searchParams: Promise.resolve({ result: "done" }) })));
    expect(html).toContain("You are unsubscribed.");
    expect(html).not.toContain("<form");
  });

  // Fails if a page state other than the fixed ones can be reached, or a malformed token gets a confirm form.
  it.each([
    [{ t: UNKNOWN }, { kind: "confirm", token: UNKNOWN }],
    [{ t: "../x" }, { kind: "result", outcome: "invalid" }],
    [{}, { kind: "result", outcome: "invalid" }],
    [{ t: [UNKNOWN, UNKNOWN] }, { kind: "result", outcome: "invalid" }],
    [{ result: "done" }, { kind: "result", outcome: "done" }],
    [{ result: "invalid" }, { kind: "result", outcome: "invalid" }],
    [{ result: "unavailable" }, { kind: "result", outcome: "unavailable" }],
    [{ result: "<script>" }, { kind: "result", outcome: "invalid" }],
  ])("page state for %j", (params, expected) => {
    expect(unsubscribePageState(params)).toEqual(expected);
  });
});

describe("POST /api/unsubscribe", () => {
  // Fails if the confirm form does not unsubscribe, does not redirect with 303 to the result page, or a second post differs.
  it("a confirm form post unsubscribes once and redirects 303 to the result page", async () => {
    const d = testDeps();
    const token = await signup(d, "form@example.test");
    const times: unknown[] = [];
    for (let n = 0; n < 2; n++) {
      const res = await handleUnsubscribePost(formPost({ t: token }, { origin: PUBLIC_ORIGIN }), d);
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe(`${PUBLIC_ORIGIN}/unsubscribe?result=done`);
      times.push(d.accountsBacking.notify.get("form@example.test")?.unsubscribedAt);
    }
    expect(times[0]).toEqual(expect.any(Number));
    expect(times[1]).toBe(times[0]);
  });

  // Fails if an unknown token is reported as unsubscribed, or anything changes for it.
  it("redirects an unknown token to the invalid-link result and changes nothing", async () => {
    const d = testDeps();
    await signup(d, "other@example.test");
    const res = await handleUnsubscribePost(formPost({ t: UNKNOWN }), d);
    expect(res.headers.get("location")).toBe(`${PUBLIC_ORIGIN}/unsubscribe?result=invalid`);
    expect(d.accountsBacking.notify.get("other@example.test")?.unsubscribedAt).toBeNull();
  });

  // Fails if RFC 8058 one-click is refused cross-origin, needs a redirect, or answers differently for an unknown token.
  it("accepts an RFC 8058 one-click post from another origin, idempotent, with one answer for known and unknown tokens", async () => {
    const d = testDeps();
    const token = await signup(d, "oneclick@example.test");
    expect(oneClickUnsubscribeUrl(PUBLIC_ORIGIN, token)).toBe(`${PUBLIC_ORIGIN}/api/unsubscribe?t=${token}`);
    const bodies: string[] = [];
    for (const t of [token, token, UNKNOWN]) {
      const res = await handleUnsubscribePost(oneClick(t), d);
      expect(res.status).toBe(200);
      bodies.push(await res.text());
    }
    expect(new Set(bodies).size).toBe(1);
    expect(d.accountsBacking.notify.get("oneclick@example.test")?.unsubscribedAt).toEqual(expect.any(Number));
  });

  // Fails if a multipart one-click body (also allowed by RFC 8058) is refused.
  it("accepts a multipart one-click body", async () => {
    const d = testDeps();
    const token = await signup(d, "multipart@example.test");
    const form = new FormData();
    form.set("List-Unsubscribe", "One-Click");
    const res = await handleUnsubscribePost(new Request(`${PUBLIC_ORIGIN}/api/unsubscribe?t=${token}`, { method: "POST", body: form }), d);
    expect(res.status).toBe(200);
    expect(d.accountsBacking.notify.get("multipart@example.test")?.unsubscribedAt).toEqual(expect.any(Number));
  });

  // Fails if a body over 2 KB is read, or a post that is neither the confirm form nor one-click changes anything.
  it("answers 413 over 2 KB and 400 for a body that is neither the confirm form nor one-click", async () => {
    const d = testDeps();
    const token = await signup(d, "edge@example.test");
    expect(UNSUBSCRIBE_MAX_BODY_BYTES).toBe(2048);
    expect((await handleUnsubscribePost(formPost({ t: token, pad: "x".repeat(2100) }), d)).status).toBe(413);
    for (const req of [formPost({}, { query: `?t=${token}` }), formPost({}, { query: `?t=${token}`, contentType: "application/json", body: JSON.stringify({ t: token }) })]) {
      expect((await handleUnsubscribePost(req, d)).status).toBe(400);
    }
    expect(d.accountsBacking.notify.get("edge@example.test")?.unsubscribedAt).toBeNull();
  });

  // Fails if a storage failure looks like success to a mail provider or to the visitor.
  it("answers 503 to one-click and redirects the form to the unavailable result when account data fails", async () => {
    captureConsole([]);
    const accounts: AccountData = {
      ...createMemoryAccountData(),
      unsubscribe: async () => {
        throw new AccountDataUnavailable("unsubscribe", "request_failed");
      },
    };
    const d = testDeps({ accounts });
    expect((await handleUnsubscribePost(oneClick(UNKNOWN), d)).status).toBe(503);
    expect((await handleUnsubscribePost(formPost({ t: UNKNOWN }), d)).headers.get("location")).toBe(`${PUBLIC_ORIGIN}/unsubscribe?result=unavailable`);
  });
});
