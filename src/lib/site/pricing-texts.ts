// Copy for /pricing, the notify form and /unsubscribe, in one module so a UI pass can restyle the
// pages without touching their logic. The plans and their features live in src/lib/billing/plans.ts.

import { LEAD_EMAIL } from "./own-site";

/** Shared by POST /api/notify, POST /api/unsubscribe, the notify form and the unsubscribe page. */
export const REQUEST_TEXT = {
  tooLarge: "That request is too large.",
  unavailable: "Retrofit could not save this right now. Try again in a few minutes.",
} as const;

export const PRICING_TEXT = {
  title: "Pricing",
  intro: "Retrofit checks how ready a website is for AI agents and builds an agent for it. These are the plans.",
  /** Shown only before BILLING_START. */
  freeNotice: "Free during the hackathon judging period. Every feature is free for everyone until paid plans start.",
  /** Beside the notice, while no plan has a price. */
  pricesNotSet: "Prices are not set yet.",
  /** Beside a plan whose price could not be read: no amount and no button. */
  priceUnavailable: "The price could not be loaded right now. Try again in a few minutes.",
  aiNote: "Without an account, the preview uses Retrofit's AI within its free limits. Your own AI key always works.",
  notifyHeading: "Hear when paid plans start",
} as const;

export const NOTIFY_FORM_TEXT = {
  emailLabel: "Email",
  consentLabel: "Send me product news",
  privacyBefore: "We email you once when paid plans start. Every message has an unsubscribe link. Read the ",
  privacyLink: "privacy notice",
  privacyAfter: ".",
  submit: "Notify me",
  busy: "Saving…",
  emptyEmail: "Enter your email address.",
} as const;

export const UNSUBSCRIBE_TEXT = {
  title: "Unsubscribe",
  confirm: "Unsubscribe this address from Retrofit's email?",
  confirmButton: "Unsubscribe",
  oneClick: "If this link belongs to a Retrofit signup, that address is unsubscribed.",
  done: "You are unsubscribed. Retrofit will not email this address again.",
  invalid: `This unsubscribe link is not valid. Email ${LEAD_EMAIL} and we will remove your address.`,
  unavailable: REQUEST_TEXT.unavailable,
} as const;
