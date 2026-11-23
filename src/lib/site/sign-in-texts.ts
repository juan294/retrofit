// Copy for /sign-in, its form and the email-link states (/auth/confirm redirects back here), in one
// module so a UI pass can restyle the page without touching its logic.

import { hhmmUtc } from "@/lib/analysis/texts";
import { LEAD_EMAIL } from "./own-site";

export const SIGN_IN_TEXT = {
  title: "Sign in",
  intro: "Enter your email address and Retrofit emails you a sign-in link. There is no password.",
  emailLabel: "Email",
  submit: "Email me a sign-in link",
  busy: "Sending…",
  sendAgain: "Send the link again",
  emptyEmail: "Enter your email address.",
  invalidEmail: "Enter a valid email address.",
  /** The same answer for every valid address, whether or not it has an account. */
  sent: "Check your email. The link works once, for one hour.",
  crossOrigin: "Open Retrofit at its own address to sign in.",
  limit: (retryAt: Date) => `You asked for too many sign-in links. Try again at ${hhmmUtc(retryAt)} UTC.`,
  /** Supabase refused to send again so soon. */
  wait: (retryAt: Date) => `Wait a minute before you ask for another link. Try again at ${hhmmUtc(retryAt)} UTC.`,
  mailUnavailable: `We could not send the sign-in email. Try again later, or email ${LEAD_EMAIL}.`,
  unavailable: "Retrofit could not start a sign-in right now. Try again in a few minutes.",
  tooLarge: "That request is too large.",
  privacyBefore: "Retrofit keeps your email address for your account. Read the ",
  privacyLink: "privacy notice",
  privacyAfter: ".",
  /** /sign-in?link=expired: an expired, used or unknown link. */
  expiredTitle: "This link has expired",
  expired: "Sign-in links work once and for one hour. Enter your email address to get a new one.",
  /** /sign-in?link=unavailable: Supabase could not check the link. */
  linkUnavailable: "Retrofit could not check your sign-in link right now. Try the link again in a few minutes, or ask for a new one.",
  /** /sign-in?account=deleted, after account deletion. */
  deleted: "Your account is deleted. Retrofit no longer keeps your saved reports or your email address.",
} as const;
