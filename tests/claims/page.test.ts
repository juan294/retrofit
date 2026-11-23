/**
 * The claim panels on /account (src/components/claims/ClaimsSection.tsx) as the server renders them,
 * before hydration: every action is a POST form whose button starts disabled, the token never
 * appears (it exists only in the browser's state after a create or Start over), and each state
 * offers only its actions.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Claim } from "@/lib/accounts/data";
import { claimView } from "@/lib/claims/view";
import { CLAIMS_TEXT } from "@/lib/site/claims-texts";
import { loadConfig } from "@/lib/config";

// The section reads the App Router (refresh after an action); server markup needs no router.
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
const { ClaimsSection } = await import("@/components/claims/ClaimsSection");

const config = loadConfig({ SESSION_SECRET: "s".repeat(32) });
const base: Claim = {
  id: "00000000-0000-4000-8000-0000000000c1",
  accountId: "4f1c2b8e-1d2a-4e55-9c3b-2a1b0c9d8e7f",
  host: "shop.example.com",
  method: "meta",
  tokenHash: "a".repeat(64),
  status: "pending",
  createdAt: "2026-11-23T10:00:00.000Z",
  verifiedAt: null,
  lastCheckedAt: "2026-11-23T10:05:00.000Z",
  failures: 1,
  supersededAt: null,
  lastResult: "robots_blocked",
  lastDetail: null,
};
const render = (claims: Claim[], options = [{ value: `analysis:${"b".repeat(32)}`, label: "shop.example.com (recent analysis)" }]) =>
  renderToStaticMarkup(createElement(ClaimsSection, { claims: claims.map((c) => claimView(c, config)), options }));

describe("claim panels before hydration", () => {
  // Fails if a button can act before hydration, or a form is not a POST to its API route.
  it("every form posts to a claim route and every button starts disabled", () => {
    const html = render([base]);
    const forms = html.match(/<form[^>]*>/g) ?? [];
    expect(forms.length).toBe(5);
    for (const f of forms) {
      expect(f).toMatch(/method="post"/);
      expect(f).toMatch(/action="\/api\/claims(\/check|\/start-over|\/remove)?"/);
    }
    const buttons = html.match(/<button[^>]*>/g) ?? [];
    expect(buttons.length).toBe(5);
    for (const b of buttons) expect(b).toMatch(/disabled=""/);
  });

  // Fails if the token hash or any token reaches the page, or the robots-blocked owner is not told to use DNS.
  it("shows where the tag goes and what was found, never the token or its hash", () => {
    const html = render([base]);
    expect(html).not.toContain("a".repeat(64));
    expect(html).not.toContain('content="');
    expect(html).toContain(CLAIMS_TEXT.reason("robots_blocked", "meta", { host: base.host, url: "https://shop.example.com/", recordName: "_retrofit-verification.shop.example.com" }, null));
    expect(html).toContain("Use the DNS method instead.");
    expect(html).toContain("Last checked 23 November 2026 at 10:05 UTC.");
  });

  // Fails if a verified claim offers Start over, or a superseded one offers anything but Remove.
  it("offers each state only its actions", () => {
    const verified = render([{ ...base, status: "verified", verifiedAt: "2026-11-23T10:05:00.000Z", lastResult: "verified" }]);
    expect(verified).toContain(CLAIMS_TEXT.checkAgain);
    expect(verified).not.toContain(CLAIMS_TEXT.startOver);
    const superseded = render([{ ...base, status: "superseded", supersededAt: "2026-11-25T08:00:00.000Z" }]);
    expect(superseded).toContain("Ownership moved to another account on 25 November 2026.");
    expect(superseded).not.toContain(CLAIMS_TEXT.checkAgain);
    expect(superseded).not.toContain(CLAIMS_TEXT.startOver);
    expect(superseded).toContain(CLAIMS_TEXT.remove);
    const lapsed = render([{ ...base, status: "lapsed", lastCheckedAt: "2026-11-26T04:41:00.000Z", lastResult: "tag_missing" }]);
    expect(lapsed).toContain("Verification failed on 26 November 2026. Your published page and badge are paused.");
    expect(lapsed).toContain(CLAIMS_TEXT.startOver);
  });

  // Fails if the claim form shows with nothing to claim, or the account with no claims is not told so.
  it("without sources or claims it says how to start", () => {
    const html = render([], []);
    expect(html).toContain(CLAIMS_TEXT.noSources);
    expect(html).toContain(CLAIMS_TEXT.noClaims);
    expect(html).not.toContain("<form");
  });
});
