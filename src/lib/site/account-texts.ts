// Copy for /account, the saved report view and the "Save this report" button, in one module so a
// UI pass can restyle these pages without touching their logic.

import { LEAD_EMAIL } from "./own-site";

export const ACCOUNT_TEXT = {
  title: "Your account",
  signedInAs: "Signed in as",
  reportsHeading: "Saved reports",
  noReports: "No saved reports yet. On a results page, choose Save this report.",
  score: (score: number | null) => (score === null ? "No score" : `${score} / 100`),
  readOn: "read on",
  signOut: "Sign out",
  deleteHeading: "Delete your account",
  deleteIntro: "This deletes your saved reports, claims, published pages and API keys, and then your sign-in. It cannot be undone.",
  deleteConfirm: "Yes, delete my account and everything in it",
  deleteButton: "Delete my account",
  deleteNeedsConfirm: "Tick the box to confirm, then choose Delete my account.",
  deleteFailed: `We could not delete your account. Nothing was deleted. Try again or email ${LEAD_EMAIL}.`,
  deletePartial: `We deleted your saved reports and other data, but could not finish deleting your account. Try again or email ${LEAD_EMAIL}.`,
  unavailable: "Retrofit could not load your account right now. Try again in a few minutes.",
  crossOrigin: "Open Retrofit at its own address to change your account.",
} as const;

export const SAVED_REPORT_TEXT = {
  title: (host: string) => `Saved report: ${host}`,
  back: "Back to your account",
  notice: (savedOn: string) => `A copy you saved on ${savedOn}. The site may have changed since Retrofit read it.`,
} as const;

export const SAVE_REPORT_TEXT = {
  button: "Save this report",
  /** On a results page for a visitor who is not signed in. */
  signIn: "Sign in to save this report",
  busy: "Saving…",
  saved: "Saved. Open it from your account.",
  openAccount: "Open your account",
  signedOut: "Sign in again to save this report.",
  notReady: "This report is not ready to save yet.",
  notFound: "Retrofit could not find this report.",
  unavailable: "Retrofit could not save this report right now. Try again in a few minutes.",
  crossOrigin: "Open Retrofit at its own address to save this report.",
} as const;

const DATE = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

/** "23 November 2026" (UTC), the date style of Retrofit's other pages. */
export function dateText(iso: string): string {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? DATE.format(ms) : iso;
}
