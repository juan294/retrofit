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
  sent: "Check your email. Open the link in this browser, on this device. The link works once, for one hour.",
  /** In the form, before anything is sent: a link opened in another browser is used up there, and the analyses here stay out of the account. */
  sameBrowser: "Open the link in this browser, on this device. A link works once.",
  crossOrigin: "Open Retrofit at its own address to sign in.",
  limit: (retryAt: Date) => `You asked for too many sign-in links. Try again at ${hhmmUtc(retryAt)} UTC.`,
  /** Supabase refused to send again so soon. */
  wait: (retryAt: Date) => `Wait a moment before you ask for another link. Try again at ${hhmmUtc(retryAt)} UTC.`,
  mailUnavailable: `We could not send the sign-in email. Try again later, or email ${LEAD_EMAIL}.`,
  /** Supabase's project-wide email limit: no wait time is known. */
  mailBusy: `Retrofit has sent too many sign-in emails for now. Try again later, or email ${LEAD_EMAIL}.`,
  unavailable: "Retrofit could not start a sign-in right now. Try again in a few minutes.",
  tooLarge: "That request is too large.",
  privacyBefore: "Retrofit keeps your email address for your account. Read the ",
  privacyLink: "privacy notice",
  privacyAfter: ".",
  /** /sign-in?link=expired: an expired, used or unknown link. */
  expiredTitle: "This link has expired",
  expired: "Sign-in links work once and for one hour. Enter your email address to get a new one.",
  /** /sign-in?link=unavailable: Supabase could not check the link (it may be used up), so the visitor asks for a new one. */
  linkUnavailable: "Retrofit could not check your sign-in link. Ask for a new link below in a few minutes.",
  /** /sign-in?account=deleted, after account deletion. */
  deleted: "Your account is deleted. Retrofit deleted your account and its data.",
  /** /auth/confirm: the page the emailed link opens. Nothing happens until the visitor chooses Sign in. */
  confirmTitle: "Sign in to Retrofit",
  confirmIntro: "Choose Sign in to finish signing in on this browser.",
  confirmButton: "Sign in",
  confirmBusy: "Signing in…",
  /** /auth/confirm?step=address: the link was not asked for on this browser for this address (another device, or a link someone else sent). */
  addressIntro: "This link signs in to the account of:",
  otherBrowser: "This link was requested from another browser. Only continue if this is your email address and you asked for this link. Signing in here will not add this browser's analyses to your account.",
  continueButton: "Continue",
  cancel: "Cancel",
  confirmInvalid: "This sign-in link is not complete. Ask for a new link.",
  newLink: "Ask for a new link",
} as const;
