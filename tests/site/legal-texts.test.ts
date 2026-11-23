import { describe, expect, it } from "vitest";
import { VISITOR_COOKIE, VISITOR_MAX_AGE_S } from "@/lib/analysis/visitor";
import { EXPIRED_GRACE_S } from "@/lib/analysis/record";
import { loadConfig } from "@/lib/config";
import { SESSION_COOKIE, SESSION_TTL_S } from "@/lib/inference/session";
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

describe("terms draft", () => {
  // Fails if the terms lose the free judging period, the ownership rule for publishing or the contact address.
  it("states the free period, the claim rule for publishing and the contact address", () => {
    const terms = text(TERMS);
    for (const s of ["2027-01-18", "claim", "unofficial", "Apache-2.0", LEAD_EMAIL]) expect(terms, s).toContain(s);
  });
});
