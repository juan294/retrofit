// ============================================================================
// DRAFT, PENDING OWNER REVIEW. Juan reads and approves both texts before any
// release that includes them (parent plan, manual check 1). They are product
// text written from what the code stores and sends, not legal advice, and
// they make no legal claims. Juan owns the final wording.
// ============================================================================
//
// OWNER REVIEW, billing (Phase 5): the lines about Stripe, test mode, the free-analysis count, API
// keys, the end of a plan and cancellation at account deletion are new. They state only what the code
// does. Refunds, taxes, invoices and the switch to live payments are not decided, so the texts promise
// nothing about them; Juan decides and adds them before live payments start.
//
// Facts come from the code: cookie names and lifetimes from their modules,
// retention from the configuration defaults. tests/site/legal-texts.test.ts
// fails when one of them drifts from the text.

import { ACCOUNT_COOKIE, ACCOUNT_SESSION_TTL_S } from "@/lib/accounts/session";
import { CLAIM_LAPSE_AFTER } from "@/lib/accounts/limits";
import { EXPIRED_GRACE_S } from "@/lib/analysis/record";
import { VISITOR_COOKIE, VISITOR_MAX_AGE_S } from "@/lib/analysis/visitor";
import { STRIPE_EVENTS_KEPT_MS } from "@/lib/api/cleanup";
import { PENDING_TTL_S, SIGN_IN_COOKIE, SIGN_IN_TTL_S } from "@/lib/api/sign-in";
import { BADGE_MAX_AGE_S } from "@/lib/badge/handler";
import { FREE_ANALYSES, FREE_WINDOW_S } from "@/lib/billing/free-limit";
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
        `__Host-${ACCOUNT_COOKIE}: set when you sign in. It keeps you signed in on this browser until you sign out, or until ${days(ACCOUNT_SESSION_TTL_S)} days pass without a visit. Retrofit stores only a hash of it, with your account id and email address.`,
        `__Host-${SIGN_IN_COOKIE}: set for ${hours(SIGN_IN_TTL_S)} hour when you ask for a sign-in link, so the link returns you to the page you were on. When you open a link on another browser, it is set there for ${PENDING_TTL_S / 60} minutes while you confirm your address. Retrofit stores only a hash of it, with that address until you confirm or the time ends.`,
        "Retrofit sets no advertising or analytics cookies.",
      ],
    },
    {
      heading: "Analyses of websites",
      body: [
        "When you ask Retrofit to score a website, RetrofitBot reads its public pages and follows its robots rules. It skips sign-in, account, cart and checkout pages.",
        `The pages it read are kept for ${CRAWL_CACHE_HOURS} hours and shared between visitors who analyze the same site. The site's verified owner can replace them with a new read after one hour.`,
        `Your analysis (a copy of those pages and the score) is private to the browser that ran it and to the signed-in account it is attached to. It is kept for ${ANALYSIS_DAYS} days, then shown as expired for ${days(EXPIRED_GRACE_S)} more days, then deleted.`,
        "To limit use, Retrofit counts requests per network with a hash of your IP address that changes every day. It does not store the address itself.",
        `From the day paid plans start, Retrofit counts the ${FREE_ANALYSES} free analyses of visitors without an account per browser and per network, with a keyed hash of your IP address (for an IPv6 address, of its first half), for up to ${days(FREE_WINDOW_S)} days. It does not store the address itself.`,
      ],
    },
    {
      heading: "AI for the preview agent",
      body: [
        "With your own AI key, your browser sends the conversation straight to the provider you chose. The key stays in your browser and never reaches Retrofit's servers.",
        "With Retrofit's free AI, Retrofit passes the conversation to its AI provider, Otari. Retrofit keeps usage and cost counts (calls per session and money spent) and never stores the conversation.",
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
      heading: "Accounts, claims, publishing and billing",
      body: [
        "An account is your email address, kept by Supabase Auth. Retrofit stores no password.",
        "When you sign in, the analyses this browser started are added to your account, but only in the browser that asked for the sign-in link.",
        "To limit sign-in emails, Retrofit keeps a keyed hash of your email address for about an hour. It does not keep the address for that." +
          ` A browser that signed in is remembered for that address with the same keyed hash and a hash of its ${VISITOR_COOKIE} cookie for ${days(VISITOR_MAX_AGE_S)} days, so nobody else can use up its sign-in emails.`,
        "A report you save is kept until you delete your account.",
        "If you claim a site, Retrofit stores the host, the method (a meta tag or a DNS record), a hash of the verification token and the results of its checks.",
        "If you publish a site's agent on Retrofit, Retrofit keeps a copy: the host, the time of the read, the address, title and text of each page (pages marked noindex are left out), the structured records, and the score with its checks, with the dates of the publish and the latest refresh and the result code of a failed refresh. It keeps no links, forms or other page code. These are public: the score and its checks, the agent, and the text, titles, addresses and structured records of the pages Retrofit read. Anyone can open them, and search engines can list the page. It does not show your email address or account.",
        `Unpublish on your account page deletes the published copy and ends the page, its files and the badge. Other sites and search engines may keep their own copies, and a badge image can stay in a browser's cache for up to ${hours(BADGE_MAX_AGE_S)} hour.`,
        `After ${CLAIM_LAPSE_AFTER} failed daily checks of your claim, the page, its files and the badge are hidden until a check passes; the copy is kept. If you remove the claim, or another account verifies the site, the copy is deleted.`,
        "A published agent works only with the visitor's own AI key, never with Retrofit's free AI. A published page and a badge set no cookie.",
        "Payments go through Stripe's own checkout and billing pages when paid plans start, for now in Stripe's test mode: no real payment is taken. When you open checkout, Stripe receives your email address and your Retrofit account id.",
        `Retrofit stores your Stripe customer id, your plan and its status, the subscription id, the end of the paid period, whether the plan ends then, and when Retrofit last checked, and, while a payment is missing, the day Retrofit first saw that. It also keeps the ids, types and times of the payment events it has handled, for ${STRIPE_EVENTS_KEPT_MS / 86_400_000} days. Card details go only to Stripe.`,
        "Retrofit shows an API key once and stores a hash of it, its last four characters and its dates. Revoking a key deletes these. Until paid plans start, calls with a key are counted per network and per account; after that, per account.",
        "Deleting your account cancels a paid plan at once, before anything else. Stripe keeps its customer and payment records. Retrofit keeps only a hash of the deleted account's Stripe customer id and the time, so that a payment that arrives late is cancelled.",
        "Deleting your account: Retrofit deletes the account and its data (claims, published pages, saved reports, API keys and sign-in sessions). The sign-in provider may keep security logs for a limited time.",
      ],
    },
    {
      heading: "Services that receive data",
      body: [
        "Vercel hosts Retrofit. Supabase stores its data. Otari runs Retrofit's free AI. Stripe takes payments when paid plans start.",
        "Retrofit sends sign-in email through Supabase Auth, which uses Amazon SES. Both receive your email address. Retrofit sends no other email yet.",
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
        "A preview agent for a site you have not claimed is private to the browser that made it and to your account when you are signed in, and labelled unofficial. It does not speak for the site's owner.",
        "You may download the files and install them on a site you own or have permission to change.",
        "Publishing an agent on Retrofit and the badge need a verified ownership claim for the site, by a meta tag or a DNS record. Publish only a site you own or have permission to publish. A published page shows a saved copy with its date, and anyone can open it.",
        "Retrofit pauses a published page and its badge when the claim stops verifying, and ends them when you unpublish, remove the claim or delete your account, or when another account verifies the site.",
      ],
    },
    {
      heading: "Free period and paid plans",
      body: [
        "Retrofit is free for everyone, including the hackathon judges, until the end of 2027-01-19 (UTC). Paid plans start after that.",
        `From then on a visitor without an account has ${FREE_ANALYSES} free analyses in ${days(FREE_WINDOW_S)} days. An account is free.`,
        "Prices are shown on the pricing page before you can buy. Payments go through Stripe, for now in Stripe's test mode: no real payment is taken.",
        "Manage billing on your account page opens Stripe's billing page, where you can cancel a plan. Deleting your account cancels a paid plan at once.",
        "When a plan ends, pages you already published stay public until you unpublish them, and reports you saved stay in your account. Publishing, refreshing, saving new reports and API keys need a plan.",
        "Retrofit's AI in the preview works within its free limits, with or without an account. Your own AI key always works.",
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
