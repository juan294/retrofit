import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// The app router is not mounted in a unit test; the form only needs push.
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {} }) }));

describe("UrlForm (review F5)", () => {
  // Fails if the status region is mounted only together with its text: a screen reader announces a live
  // region's changes, not its insertion, so the retry text would not be read.
  it("renders the status region before there is any text in it", async () => {
    const { UrlForm } = await import("@/components/UrlForm");
    const html = renderToStaticMarkup(createElement(UrlForm));
    expect(html).toMatch(/<p role="status"[^>]*><\/p>/);
  });

  // FE-M1. Fails if an early click or Enter can submit the form as GET (the page would reload with the address in its URL and no analysis):
  // the form must post to the API and its button must start disabled.
  it("posts to /api/analyze and keeps its button disabled until the page is hydrated", async () => {
    const { UrlForm } = await import("@/components/UrlForm");
    const html = renderToStaticMarkup(createElement(UrlForm));
    const form = /<form[^>]*>/.exec(html)?.[0] ?? "";
    expect(form).toMatch(/method="post"/);
    expect(form).toMatch(/action="\/api\/analyze"/);
    expect(/<button[^>]*type="submit"[^>]*>/.exec(html)?.[0]).toMatch(/disabled=""/);
  });
});
