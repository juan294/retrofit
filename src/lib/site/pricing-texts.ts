// Copy for /pricing, the notify form and /unsubscribe, in one module so a UI pass can restyle the
// pages without touching their logic. The plans and their features live in src/lib/billing/plans.ts.

export const PRICING_TEXT = {
  title: "Pricing",
  intro: "Retrofit checks how ready a website is for AI agents and builds an agent for it. These are the plans.",
  freeNotice: "Free during the hackathon judging period",
  freeNoticeDetail: "Every feature is free for everyone until paid plans start. Prices are not set yet.",
  notifyHeading: "Hear when paid plans start",
} as const;

/** The free-period note, shown only before BILLING_START. */
export function pricingNotice(now: number, billingStart: number): string | null {
  return now < billingStart ? PRICING_TEXT.freeNotice : null;
}

export const NOTIFY_FORM_TEXT = {
  emailLabel: "Email",
  consentLabel: "Send me product news",
  privacyBefore: "We email you once when paid plans start. Every message has an unsubscribe link. Read the ",
  privacyLink: "privacy notice",
  privacyAfter: ".",
  submit: "Notify me",
  busy: "Saving…",
  emptyEmail: "Enter your email address.",
  unavailable: "Retrofit could not save your address. Try again in a few minutes.",
} as const;

export const UNSUBSCRIBE_TEXT = {
  title: "Unsubscribe",
  done: "You are unsubscribed. Retrofit will not email this address again.",
  invalid: "This unsubscribe link is not valid. Email retrofit@thecreativetoken.com and we will remove your address.",
  unavailable: "Retrofit could not unsubscribe you right now. Open the link again in a few minutes.",
  home: "Back to Retrofit",
} as const;
