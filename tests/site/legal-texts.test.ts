import { describe, expect, it } from "vitest";
import { VISITOR_COOKIE, VISITOR_MAX_AGE_S } from "@/lib/analysis/visitor";
import { EXPIRED_GRACE_S } from "@/lib/analysis/record";
import { loadConfig } from "@/lib/config";
import { SESSION_COOKIE, SESSION_TTL_S } from "@/lib/inference/session";
import { ACCOUNT_COOKIE, ACCOUNT_SESSION_TTL_S } from "@/lib/accounts/session";
import { SIGN_IN_COOKIE, SIGN_IN_TTL_S } from "@/lib/api/sign-in";
import { PRIVACY, TERMS, type LegalDocument } from "@/lib/site/legal-texts";
import { CLAIM_LAPSE_AFTER } from "@/lib/accounts/limits";
import { BADGE_MAX_AGE_S } from "@/lib/badge/handler";
import { LEAD_EMAIL } from "@/lib/site/own-site";

const text = (d: LegalDocument) => [d.title, d.intro, ...d.sections.flatMap((s) => [s.heading, ...s.body])].join("\n");
const defaults = loadConfig({ SESSION_SECRET: "s".repeat(32) });

describe("privacy notice draft", () => {
  const privacy = text(PRIVACY);

  // Fails if the notice stops naming a cookie the code sets, or a cookie lifetime drifts from the code.
  it("names every cookie with the lifetime the code gives it", () => {
    expect(privacy).toContain(`${VISITOR_COOKIE}`);
    expect(privacy).toContain(`${VISITOR_MAX_AGE_S / 86400} days`);
    expect(privacy).toContain(`${SESSION_COOKIE}`);
    expect(privacy).toContain(`${SESSION_TTL_S / 3600} hours`);
    expect(privacy).toContain("retrofit_account");
    expect(privacy).toContain(`${ACCOUNT_COOKIE}: set when you sign in`);
    expect(privacy).toContain(`${ACCOUNT_SESSION_TTL_S / 86400} days pass without a visit`);
    expect(privacy).toContain(`${SIGN_IN_COOKIE}: set for ${SIGN_IN_TTL_S / 3600} hour`);
  });

  // Fails if a retention period in the notice differs from the defaults the code applies.
  it("states the crawl cache and analysis retention the code applies", () => {
    expect(privacy).toContain(`${defaults.crawlCacheTtlS / 3600} hours`);
    expect(privacy).toContain(`${defaults.analysisTtlS / 86400} days`);
    expect(privacy).toContain(`${EXPIRED_GRACE_S / 86400} more days`);
  });

  // Fails if a stored kind of data or a receiving service is left out of the notice.
  it("covers what is stored and every service that receives data", () => {
    for (const s of ["Notify me", "marketing", "unsubscribe", "claim", "publish", "Stripe", "RetrofitBot", "Otari", "Amazon SES", "Supabase", "Vercel", "your own AI key", LEAD_EMAIL]) {
      expect(privacy, s).toContain(s);
    }
  });
});

describe("privacy notice accuracy", () => {
  const privacy = text(PRIVACY);

  // Fails if the free-AI line claims less than the ledger keeps (usage and cost) or implies the conversation is kept.
  it("describes the free-AI records as usage and cost counts, never the conversation", () => {
    expect(privacy).not.toContain("number of tokens");
    expect(privacy).toContain("usage and cost counts");
    expect(privacy).toContain("never stores the conversation");
  });

  // P2-R3. Fails if the notice hides the sign-in email (sent through Supabase Auth with Amazon SES) or says other email is sent.
  it("says sign-in email goes through Supabase Auth and Amazon SES, which receive the address, and no other email is sent yet", () => {
    expect(privacy).not.toContain("Retrofit sends no email yet");
    expect(privacy).toContain("Retrofit sends sign-in email through Supabase Auth, which uses Amazon SES. Both receive your email address.");
    expect(privacy).toContain("Retrofit sends no other email yet.");
  });
});

describe("privacy notice for accounts", () => {
  const privacy = text(PRIVACY);

  // P2-R3. Fails if the sign-in limit's keyed hash of the address goes unmentioned or its lifetime drifts from about an hour.
  it("states the keyed hash of the address kept about an hour for sign-in limits", () => {
    expect(privacy).toContain("a keyed hash of your email address for about an hour");
  });

  // P2-R3. Fails if the notice says an analysis is private to the browser only, or hides when analyses join an account.
  it("says who can open an analysis and when analyses attach to an account", () => {
    expect(privacy).toContain("private to the browser that ran it and to the signed-in account it is attached to");
    expect(privacy).toContain("only in the browser that asked for the sign-in link");
    expect(privacy).not.toContain("is private to your browser.");
    expect(text(TERMS)).toContain("private to the browser that made it and to your account");
  });

  // P2-R3. Fails if the account section still says accounts are not available, or deletion claims the provider keeps nothing.
  it("describes accounts as available and deletion without claiming the sign-in provider keeps nothing", () => {
    expect(PRIVACY.sections.map((x) => x.heading)).toContain("Accounts, claims, publishing and billing");
    expect(privacy).not.toContain("(when available)");
    expect(privacy).toContain("Deleting your account: Retrofit deletes the account and its data");
    expect(privacy).toContain("may keep security logs for a limited time");
  });
});

describe("terms draft", () => {
  // Fails if the terms lose the free judging period, the ownership rule for publishing or the contact address.
  it("states the free period, the claim rule for publishing and the contact address", () => {
    const terms = text(TERMS);
    for (const s of ["2027-01-18", "claim", "unofficial", "Apache-2.0", LEAD_EMAIL]) expect(terms, s).toContain(s);
  });
});

// Phase 4. The facts come from src/lib/publish/*, src/lib/badge/* and AccountData publishSite; the numbers from the code.
describe("publishing in the privacy notice and the terms", () => {
  const privacy = text(PRIVACY);
  const terms = text(TERMS);

  // Fails if the notice hides what publishing makes public, or still calls publishing unavailable.
  it("says what a published page makes public, and that it does not name the account", () => {
    expect(privacy).not.toContain("when publishing is available");
    expect(privacy).toContain("the score and its checks, the agent, and the text, titles, addresses and structured records of the pages Retrofit read");
    expect(privacy).toContain("Anyone can open them, and search engines can list the page");
    expect(privacy).toContain("It does not show your email address or account");
  });

  // Fails if the notice is wrong about what a publication keeps: agentSnapshot's fields, the report, the dates and the last refresh's code.
  it("says what is kept of a published site, and what is not", () => {
    expect(privacy).toContain("the host, the time of the read, the address, title and text of each page (pages marked noindex are left out), the structured records, and the score with its checks, with the dates of the publish and the latest refresh and the result code of a failed refresh");
    expect(privacy).toContain("It keeps no links, forms or other page code.");
  });

  // Fails if the notice does not say how to unpublish, or promises more than the badge's cache allows.
  it("says how to unpublish, what that deletes, and how long a badge can stay cached", () => {
    expect(privacy).toContain("Unpublish on your account page deletes the published copy and ends the page, its files and the badge");
    expect(privacy).toContain(`a badge image can stay in a browser's cache for up to ${BADGE_MAX_AGE_S / 3600} hour`);
  });

  // Fails if the notice is wrong about a lapse (hidden, kept), a transfer, removing the claim or account deletion (deleted).
  it("says what happens on a lapse, a transfer, removing the claim and account deletion", () => {
    expect(privacy).toContain(`After ${CLAIM_LAPSE_AFTER} failed daily checks of your claim, the page, its files and the badge are hidden until a check passes; the copy is kept.`);
    expect(privacy).toContain("If you remove the claim, or another account verifies the site, the copy is deleted.");
    expect(privacy).toContain("Retrofit deletes the account and its data (claims, published pages,");
  });

  // Fails if the notice lets a visitor think a published agent uses Retrofit's free AI or sends Retrofit the key or conversation.
  it("says a published agent uses only the visitor's own key and the page sets no cookie", () => {
    expect(privacy).toContain("A published agent works only with the visitor's own AI key, never with Retrofit's free AI. A published page and a badge set no cookie.");
  });

  // Fails if the terms let anyone publish, or hide that a claim that stops verifying ends the page.
  it("the terms keep the claim rule and say when a published page pauses or ends", () => {
    expect(terms).toContain("need a verified ownership claim for the site");
    expect(terms).toContain("Retrofit pauses a published page and its badge when the claim stops verifying, and ends them when you unpublish, remove the claim or delete your account, or when another account verifies the site.");
    expect(terms).toContain("Publish only a site you own or have permission to publish.");
    expect(terms).toContain("shows a saved copy with its date");
  });
});
