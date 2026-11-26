import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { postJson, statusOf } from "@/components/post";
import { StatusMessage } from "@/components/StatusMessage";
import { PLAN_TEXT } from "@/lib/site/plan-texts";

afterEach(() => vi.unstubAllGlobals());
const answer = (status: number, body: unknown) => ({ status, ok: status < 300, body: body as { message?: unknown } | null });

describe("an answer on the page", () => {
  // Fails if a network failure or a broken answer throws in a form (the button would stay busy).
  it("postJson never throws, and posts same-origin JSON", async () => {
    const calls: [string, RequestInit][] = [];
    vi.stubGlobal("fetch", async (path: string, init: RequestInit) => (calls.push([path, init]), new Response('{"message":"m"}', { status: 409 })));
    expect(await postJson("/api/x", { a: 1 })).toEqual({ status: 409, ok: false, body: { message: "m" } });
    expect(calls[0]).toEqual(["/api/x", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: '{"a":1}' }]);
    vi.stubGlobal("fetch", async () => new Response("<html>", { status: 502 }));
    expect(await postJson("/api/x", {})).toEqual({ status: 502, ok: false, body: null });
    vi.stubGlobal("fetch", async () => Promise.reject(new TypeError("offline")));
    expect(await postJson("/api/x", {})).toEqual({ status: 0, ok: false, body: null });
  });

  // Fails if a message is lost, a refusal keeps UTC, a success is changed, or a link the answer names is followed anywhere but to the plans.
  it("statusOf takes the message, localizes a refusal's time, and links only to the plans or to sign-in", () => {
    expect(statusOf(answer(200, { message: "Done at 10:00 UTC", retryAt: "2027-01-01T10:00:00Z" }), "no", "/account")).toEqual({ ok: true, text: "Done at 10:00 UTC" });
    expect(statusOf(answer(429, { message: "Try again at 10:00 UTC.", retryAt: "2027-01-01T10:00:00Z" }), "no", "/account").text).not.toContain("UTC");
    expect(statusOf(answer(503, null), "no", "/account")).toEqual({ ok: false, text: "no" });
    expect(statusOf(answer(403, { message: "m", href: "/pricing" }), "no", "/account")).toEqual({ ok: false, text: "m", href: "/pricing", linkText: PLAN_TEXT.seePlans });
    expect(statusOf(answer(403, { message: "m", href: "https://evil.example" }), "no", "/account")).toEqual({ ok: false, text: "m" });
    // UX-H1. A signed-out visitor gets the sign-in page, and returns to where they were.
    expect(statusOf(answer(401, { message: "Sign in again." }), "no", "/r/1")).toEqual({ ok: false, text: "Sign in again.", href: "/sign-in?returnTo=%2Fr%2F1", linkText: PLAN_TEXT.signIn });
  });

  // UX-M2. Fails if the status region is not mounted before its text (a screen reader announces a live region's changes, not its
  // insertion), a failure is not an alert, the id and test id are not on the element that shows the text, or a text without a link gains a space.
  it("StatusMessage keeps a status region mounted, and shows a failure as an alert beside it", () => {
    const html = (status: Parameters<typeof StatusMessage>[0]["status"]) => renderToStaticMarkup(createElement(StatusMessage, { status, id: "i", testId: "t" }));
    expect(html(null)).toBe('<p role="status" id="i" data-testid="t" class="empty:absolute"></p>');
    expect(html({ ok: true, text: "Saved." })).toBe('<p role="status" id="i" data-testid="t" class="empty:absolute">Saved.</p>');
    // The failure is the body of a notice: the role, the id and the test id are on the body, so the alert's text is the answer alone.
    expect(html({ ok: false, text: "No.", href: "/pricing", linkText: "See" })).toBe(
      '<p role="status" class="empty:absolute"></p><div class="fi-notice fi-notice-action"><div class="fi-notice-head fi-mono">Action needed</div><div class="fi-notice-body" role="alert" id="i" data-testid="t">No. <a href="/pricing" class="underline">See</a></div></div>',
    );
  });
});
