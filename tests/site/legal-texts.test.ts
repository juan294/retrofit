import { describe, expect, it } from "vitest";
import { VISITOR_COOKIE, VISITOR_MAX_AGE_S } from "@/lib/analysis/visitor";
import { EXPIRED_GRACE_S } from "@/lib/analysis/record";
import { loadConfig } from "@/lib/config";
import { SESSION_COOKIE, SESSION_TTL_S } from "@/lib/inference/session";
import { ACCOUNT_COOKIE, ACCOUNT_SESSION_TTL_S } from "@/lib/accounts/session";
import { SIGN_IN_COOKIE, SIGN_IN_TTL_S } from "@/lib/api/sign-in";
import { PRIVACY, TERMS, type LegalDocument } from "@/lib/site/legal-texts";
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
