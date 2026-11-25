import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ApiKeysSection } from "@/components/billing/ApiKeysSection";
import { API_KEY_TEXT as T } from "@/lib/site/billing-texts";

const keys = [
  { id: "k1", hint: "ab12", createdOn: "20 November 2026" },
  { id: "k2", hint: null, createdOn: "21 November 2026" },
];
const html = renderToStaticMarkup(createElement(ApiKeysSection, { keys }));

describe("the API keys on /account before hydration", () => {
  // UX-M1. Fails if one click on Revoke can end a key, a button acts before hydration, or two Revoke buttons have the same name.
  it("Revoke opens a second step and names its key", () => {
    expect(html).not.toContain('action="/api/account/keys/revoke"');
    for (const b of html.match(/<button[^>]*>/g) ?? []) expect(b).toMatch(/ disabled=""/);
    const names = [...html.matchAll(/<button type="button"[^>]*aria-label="([^"]*)"/g)].map((m) => m[1]);
    expect(names).toEqual(["Revoke: Key ending in ab12, created on 20 November 2026", "Revoke: Key, created on 21 November 2026"]);
    expect(T.revokeQuestion("ab12")).toContain("ab12");
    expect(T.revokeQuestion("ab12")).toContain("stops working at once");
  });

  // UX-M2. Fails if "Copy your key now" arrives together with its status region, or the heading cannot take the focus of a revoked key's button.
  it("has its status region and focus place before any action", () => {
    expect(html).toMatch(/<p role="status" data-testid="api-keys-message"[^>]*><\/p>/);
    expect(html).toMatch(new RegExp(`<h2 tabindex="-1"[^>]*>${T.heading}<`));
  });

  // UX-L1. Fails if the text promises a key more than an anonymous call before paid plans start.
  it("says when a key's higher limits start", () => {
    expect(T.intro).not.toContain("many sites");
    expect(T.intro).toContain("Until paid plans start, a key gives no higher limits than a call without one.");
  });
});
