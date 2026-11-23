// ============================================================================
// DRAFT, PENDING OWNER REVIEW. Juan reads and approves both texts before any
// release that includes them (parent plan, manual check 1). They are product
// text written from what the code stores and sends, not legal advice, and
// they make no legal claims. Juan owns the final wording.
// ============================================================================
//
// Facts come from the code: cookie names and lifetimes from their modules,
// retention from the configuration defaults. tests/site/legal-texts.test.ts
// fails when one of them drifts from the text.

import { EXPIRED_GRACE_S } from "@/lib/analysis/record";
import { VISITOR_COOKIE, VISITOR_MAX_AGE_S } from "@/lib/analysis/visitor";
import { SESSION_COOKIE, SESSION_TTL_S } from "@/lib/inference/session";
import { LEAD_EMAIL, SOURCE_URL } from "./own-site";

export interface LegalSection {
  readonly heading: string;
  readonly body: readonly string[];
}

export interface LegalDocument {
  readonly title: string;
  readonly intro: string;
  readonly sections: readonly LegalSection[];
}

/** Configuration defaults (src/lib/config.ts CRAWL_CACHE_TTL_S, ANALYSIS_TTL_S). */
const CRAWL_CACHE_HOURS = 24;
const ANALYSIS_DAYS = 7;
const days = (s: number) => s / 86400;
const hours = (s: number) => s / 3600;

export const PRIVACY: LegalDocument = {
  title: "Privacy",
  intro: `This page explains what Retrofit stores, for how long, and which services receive data. Questions or requests: ${LEAD_EMAIL}.`,
  sections: [
    {
      heading: "Cookies",
      body: [
        `${VISITOR_COOKIE}: a random identifier for your browser, kept for ${days(VISITOR_MAX_AGE_S)} days. It shows that the analyses you started are yours. Retrofit stores only a hash of it.`,
        `${SESSION_COOKIE}: set only when you use Retrofit's free AI, kept for ${hours(SESSION_TTL_S)} hours and sent only to Retrofit's AI routes.`,
        "retrofit_account: set when you sign in, once accounts are available. It keeps you signed in on this browser.",
        "Retrofit sets no advertising or analytics cookies.",
      ],
    },
    {
      heading: "Analyses of websites",
      body: [
        "When you ask Retrofit to score a website, RetrofitBot reads its public pages and follows its robots rules. It skips sign-in, account, cart and checkout pages.",
        `The pages it read are kept for ${CRAWL_CACHE_HOURS} hours and shared between visitors who analyze the same site.`,
        `Your analysis (a copy of those pages and the score) is private to your browser. It is kept for ${ANALYSIS_DAYS} days, then shown as expired for ${days(EXPIRED_GRACE_S)} more days, then deleted.`,
        "To limit use, Retrofit counts requests per network with a hash of your IP address that changes every day. It does not store the address itself.",
      ],
    },
    {
      heading: "AI for the preview agent",
      body: [
        "With your own AI key, your browser sends the conversation straight to the provider you chose. The key stays in your browser and never reaches Retrofit's servers.",
        "With Retrofit's free AI, Retrofit passes the conversation to its AI provider, Otari, and keeps only the number of tokens used.",
      ],
    },
    {
      heading: "Notify me",
      body: [
        "If you join the list on the pricing page, Retrofit stores your email address, the time, and whether you ticked the box for product news (marketing consent is off unless you tick it).",
        "Every message carries an unsubscribe link. After you unsubscribe, Retrofit keeps the address with the time you left, so it does not email you again. To have it deleted, email us.",
      ],
    },
    {
      heading: "Accounts, claims, publishing and billing (when available)",
      body: [
        "An account is your email address, kept by Supabase Auth. Retrofit stores no password.",
        "If you claim a site, Retrofit stores the host, the method (a meta tag or a DNS record), a hash of the verification token and the results of its checks.",
        "If you publish a site's agent on Retrofit, the copy of its public pages and its score are kept until you unpublish it, and they are public.",
        "Payments go through Stripe. Retrofit stores your Stripe customer id, your plan and its renewal date. Card details go only to Stripe.",
        "Deleting your account deletes your claims, published pages, saved reports and API keys.",
      ],
    },
    {
      heading: "Services that receive data",
      body: [
        "Vercel hosts Retrofit. Supabase stores its data. Amazon SES sends its email. Otari runs Retrofit's free AI. Stripe takes payments when paid plans start.",
        `Retrofit's source code is public: ${SOURCE_URL}.`,
      ],
    },
  ],
};

export const TERMS: LegalDocument = {
  title: "Terms",
  intro: `These terms cover your use of Retrofit. Questions: ${LEAD_EMAIL}.`,
  sections: [
    {
      heading: "Using Retrofit",
      body: [
        "You may ask Retrofit to score any public website. Retrofit reads only public pages and follows the site's robots rules.",
        "Do not use Retrofit to overload a site, to get around its rules, or to read pages that are not public.",
        "Retrofit limits how many requests one network can make. The limits can change.",
      ],
    },
    {
      heading: "Previews, files and publishing",
      body: [
        "A preview agent for a site you have not claimed is private to your browser and labelled unofficial. It does not speak for the site's owner.",
        "You may download the files and install them on a site you own or have permission to change.",
        "Publishing an agent on Retrofit and the badge need a verified ownership claim for the site, by a meta tag or a DNS record. Retrofit pauses a published page when the claim stops verifying.",
      ],
    },
    {
      heading: "Free period and paid plans",
      body: [
        "Retrofit is free for everyone, including the hackathon judges, until 2027-01-18. Paid plans start after that date.",
        "Prices are shown on the pricing page before you can buy. Payments go through Stripe.",
      ],
    },
    {
      heading: "AI answers",
      body: [
        "Preview agents use AI models. Their answers can be wrong. Check important information with the site itself.",
        "When you use your own AI key, your provider's terms apply to that use.",
      ],
    },
    {
      heading: "Source code and changes",
      body: [
        `Retrofit's source code is open under the Apache-2.0 license: ${SOURCE_URL}.`,
        "Retrofit can change these terms. The pricing, privacy and terms pages always show the current version.",
      ],
    },
  ],
};
