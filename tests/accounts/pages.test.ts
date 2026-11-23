import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SaveReportButton } from "@/components/analysis/SaveReportButton";
import { SignInForm } from "@/components/SignInForm";
import { GET as mailbox } from "@/app/test-fixtures/mailbox/route";

describe("sign-in form", () => {
  // Fails if a click before hydration can submit the form as GET (the address would land in the page URL,
  // history and logs): the form must post to the API and its button must start disabled.
  it("posts to /api/auth/sign-in and keeps its button disabled until the page is hydrated", () => {
    const html = renderToStaticMarkup(createElement(SignInForm, { returnTo: "/account", privacyHref: "/privacy" }));
    const form = /<form[^>]*>/.exec(html)?.[0] ?? "";
    expect(form).toMatch(/method="post"/);
    expect(form).toMatch(/action="\/api\/auth\/sign-in"/);
    expect(html).toMatch(/<input[^>]*type="email"[^>]*name="email"|<input[^>]*name="email"[^>]*type="email"/);
    expect(/<button[^>]*type="submit"[^>]*>/.exec(html)?.[0]).toMatch(/disabled=""/);
    expect(html).toContain('href="/privacy"');
  });

  // Fails if the save button can be clicked before hydration (the click would do nothing and look broken).
  it("save button starts disabled", () => {
    expect(/<button[^>]*>/.exec(renderToStaticMarkup(createElement(SaveReportButton, { analysisId: "0".repeat(32) })))?.[0]).toMatch(/disabled=""/);
  });
});

describe("fixture mailbox route", () => {
  // Fails if the sign-in mailbox (it holds live sign-in links) answers outside fixtures mode.
  it("answers 404 outside fixtures mode", async () => {
    expect(process.env.RETROFIT_TEST_FIXTURES).toBeFalsy();
    const res = mailbox(new Request("http://127.0.0.1:3010/test-fixtures/mailbox?email=a@example.test"));
    expect(res.status).toBe(404);
  });
});
