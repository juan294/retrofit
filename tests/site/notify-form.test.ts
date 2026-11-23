import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NotifyForm } from "@/components/NotifyForm";
import { pricingNotice } from "@/lib/site/pricing-texts";

describe("NotifyForm", () => {
  // Fails if the consent box starts ticked, or the form renders without its privacy link.
  it("renders an email field, an unticked consent box and the privacy link", () => {
    const html = renderToStaticMarkup(createElement(NotifyForm, { privacyHref: "/privacy" }));
    expect(html).toMatch(/<input[^>]*type="email"/);
    const box = /<input[^>]*type="checkbox"[^>]*>/.exec(html)?.[0] ?? "";
    expect(box).not.toBe("");
    expect(box).not.toMatch(/checked/);
    expect(html).toContain('href="/privacy"');
  });

  // Fails if a click before hydration can submit the form as GET (the address would land in the page URL,
  // history and logs): the form must post to the API and its button must start disabled.
  it("posts to /api/notify and keeps its button disabled until the page is hydrated", () => {
    const html = renderToStaticMarkup(createElement(NotifyForm, { privacyHref: "/privacy" }));
    const form = /<form[^>]*>/.exec(html)?.[0] ?? "";
    expect(form).toMatch(/method="post"/);
    expect(form).toMatch(/action="\/api\/notify"/);
    expect(/<button[^>]*type="submit"[^>]*>/.exec(html)?.[0]).toMatch(/disabled=""/);
  });

  // Fails if the form can be shown without a privacy link (the plan refuses the form then).
  it("renders nothing without a privacy link", () => {
    expect(renderToStaticMarkup(createElement(NotifyForm, { privacyHref: "" }))).toBe("");
  });
});

describe("pricing notice", () => {
  const start = Date.parse("2027-01-19T00:00:00Z");
  // Fails if the free-period note shows after billing starts or is missing before it.
  it("shows the free judging period note only before BILLING_START", () => {
    expect(pricingNotice(start - 1, start)).toBe("Free during the hackathon judging period");
    expect(pricingNotice(start, start)).toBeNull();
  });
});
