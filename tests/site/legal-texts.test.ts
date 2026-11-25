import { describe, expect, it } from "vitest";
import { UNCONFIRMED_KEPT_MS } from "@/lib/api/cleanup";
import { JUDGE_SESSION_TTL_S } from "@/lib/inference/session";
import { VISITOR_COOKIE, VISITOR_MAX_AGE_S } from "@/lib/analysis/visitor";
import { EXPIRED_GRACE_S } from "@/lib/analysis/record";
import { STRIPE_EVENTS_KEPT_MS } from "@/lib/api/cleanup";
import { FEATURE_LABELS } from "@/lib/billing/plans";
import { PLAN_TEXT } from "@/lib/site/plan-texts";
import { PRICING_TEXT } from "@/lib/site/pricing-texts";
import { FREE_ANALYSES, FREE_WINDOW_S } from "@/lib/billing/free-limit";
import { loadConfig } from "@/lib/config";
import { SESSION_COOKIE, SESSION_TTL_S } from "@/lib/inference/session";
import { ACCOUNT_COOKIE, ACCOUNT_SESSION_TTL_S } from "@/lib/accounts/session";
import { PENDING_COOKIE, PENDING_TTL_S, SIGN_IN_COOKIE, SIGN_IN_TTL_S } from "@/lib/api/sign-in";
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
    expect(privacy).toContain(`${PENDING_COOKIE}: set for ${PENDING_TTL_S / 60} minutes`);
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
    expect(privacy).toContain(`A browser that signed in is remembered for that address with the same keyed hash and a hash of its ${VISITOR_COOKIE} cookie for ${VISITOR_MAX_AGE_S / 86400} days`);
  });

  // SE-M2, UX-H3. Fails if the notice hides what the sign-in provider keeps of an unopened link, or how long judge access lasts.
  it("states the life of an address whose link was never opened, and of judge access", () => {
    expect(privacy).toContain("the sign-in provider keeps the typed address. If nobody opens the link, it is deleted after about a day.");
    expect(privacy).toContain(`with judge access, for ${JUDGE_SESSION_TTL_S / 86400} days after the last visit`);
    expect(UNCONFIRMED_KEPT_MS).toBe(24 * 3600_000);
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
    for (const s of ["until the end of 2027-01-19 (UTC)", "claim", "unofficial", "Apache-2.0", LEAD_EMAIL]) expect(terms, s).toContain(s);
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

// Phase 5. The facts come from src/lib/billing/*, the billing migration and account deletion; the numbers from the code.
describe("payments, the free limit and API keys in the privacy notice and the terms", () => {
  const privacy = text(PRIVACY);
  const terms = text(TERMS);

  // Fails if the notice leaves out something billing stores or sends, or lets a visitor think Retrofit sees the card.
  it("says what Stripe receives, what Retrofit stores, and that card details go only to Stripe", () => {
    expect(privacy).toContain("When you open checkout, Stripe receives your email address and your Retrofit account id.");
    expect(privacy).toContain("your Stripe customer id, your plan and its status, the subscription id, the end of the paid period, whether the plan ends then, and when Retrofit last checked");
    expect(privacy).toContain("the ids, types and times of the payment events it has handled");
    expect(privacy).toContain("Card details go only to Stripe.");
  });

  // Fails if the drafts hide that payments are in test mode while the configuration accepts test keys only.
  it("says payments run in Stripe's test mode, as the configuration requires", () => {
    expect(() => loadConfig({ SESSION_SECRET: "s".repeat(32), STRIPE_SECRET_KEY: "sk_live_x", STRIPE_WEBHOOK_SECRET: "whsec_x" })).toThrow(/test-mode/);
    for (const t of [privacy, terms]) expect(t).toContain("Stripe's test mode: no real payment is taken");
  });

  // Fails if the long-lived network hash of the free limit goes unmentioned, or its period drifts from the code.
  it("states the free-analysis count, its hash and its period", () => {
    expect(privacy).toContain(`counts the ${FREE_ANALYSES} free analyses of visitors without an account per browser and per network, with a keyed hash of your IP address (for an IPv6 address, of its first half), for up to ${FREE_WINDOW_S / 86400} days`);
    expect(terms).toContain(`${FREE_ANALYSES} free analyses in ${FREE_WINDOW_S / 86400} days`);
  });

  // P5-RR5. Fails if the notice is wrong about whom a call with a key counts before paid plans start, or hides the stored unpaid date.
  it("is true about the counting of calls with a key on both sides of the start, and names the unpaid date", () => {
    expect(privacy).toContain("Until paid plans start, calls with a key are counted per network and per account; after that, per account.");
    expect(privacy).not.toContain("are counted per account, not per network");
    expect(privacy).toContain("and, while a payment is missing, the day Retrofit first saw that");
  });

  // Simplify 13. Fails if the notice is wrong about how long payment events and revoked keys are kept.
  it("says how long payment events are kept and that revoking a key deletes it", () => {
    expect(privacy).toContain(`the payment events it has handled, for ${STRIPE_EVENTS_KEPT_MS / 86_400_000} days.`);
    expect(privacy).toContain("Revoking a key deletes these.");
  });

  // Fails if the notice hides what is kept of an API key.
  it("says what is kept of an API key", () => {
    expect(privacy).toContain("Retrofit shows an API key once and stores a hash of it, its last four characters and its dates.");
  });

  // P5-R1. Fails if the notice hides the mark that a deletion leaves of the Stripe customer.
  it("says what is kept of a deleted account's Stripe customer, and why", () => {
    expect(privacy).toContain("Retrofit keeps only a hash of the deleted account's Stripe customer id and the time, so that a payment that arrives late is cancelled.");
  });

  // P5-R11, owner decision 2026-11-25. Fails if a text says that Retrofit's AI in the preview needs a plan.
  it("is true about Retrofit's AI for visitors without an account, Free accounts and plans", () => {
    expect(terms).toContain("Retrofit's AI in the preview works within its free limits, with or without an account. Your own AI key always works.");
    expect(terms).not.toMatch(/Retrofit's AI and API keys need a plan/);
    expect(FEATURE_LABELS.free_ai_preview).toContain("within its free limits");
    expect(Object.keys(PLAN_TEXT.required)).not.toContain("free_ai_preview");
    expect(PRICING_TEXT.aiNote).toContain("with or without an account");
  });

  // P5-R13. Fails if the notice hides that an IPv6 address counts as its network part.
  it("says that an IPv6 address counts by its network part", () => {
    expect(privacy).toContain("for an IPv6 address, of its first half");
  });

  // Fails if the drafts are wrong about the end of a plan or about account deletion, or promise refunds or tax terms nobody decided.
  it("says what the end of a plan and account deletion do, and promises nothing about refunds or tax", () => {
    expect(terms).toContain("When a plan ends, pages you already published stay public until you unpublish them, and reports you saved stay in your account.");
    for (const t of [privacy, terms]) expect(t).toContain("cancels a paid plan at once");
    expect(privacy).toContain("Stripe keeps its customer and payment records.");
    for (const t of [privacy, terms]) expect(t).not.toMatch(/refund|\bVAT\b|\btax/i);
  });
});
