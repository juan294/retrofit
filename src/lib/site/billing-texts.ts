// Copy for plans, checkout, the billing section of /account and API keys, in one module so a UI pass
// can restyle them without touching their logic. The plans and their features live in
// src/lib/billing/plans.ts; amounts come from Stripe.

import { API_KEY_CREATES_PER_HOUR, BILLING_ACTIONS_PER_HOUR, MAX_API_KEYS } from "@/lib/accounts/limits";
import { hhmmUtc } from "@/lib/analysis/texts";
import type { Feature } from "@/lib/billing/plans";
import { LEAD_EMAIL } from "./own-site";

/** Why a feature needs a plan, for the features a route refuses. */
export type GatedFeature = Extract<Feature, "publish" | "saved_reports" | "free_ai_preview" | "api_keys">;

export const PLAN_TEXT = {
  required: {
    publish: "Publishing and refreshing need a paid plan. Pages you already published stay public.",
    saved_reports: "Saving reports needs a paid plan. Reports you already saved stay in your account.",
    free_ai_preview: "Retrofit's AI is part of the paid plans. Use your own AI key to continue.",
    api_keys: "API keys need a paid plan.",
  } satisfies Record<GatedFeature, string>,
  unavailable: "Retrofit could not check your plan right now. Nothing was changed. Try again in a few minutes.",
  seePlans: "See the plans",
} as const;

export const BILLING_TEXT = {
  heading: "Your plan",
  renews: (date: string) => `Renews on ${date}.`,
  ends: (date: string) => `Cancelled. It ends on ${date}.`,
  pastDue: (date: string) => `The last payment failed. Choose Manage billing to update your card. Your plan stays until ${date}.`,
  ended: "Your plan has ended.",
  notPaid: "Your plan is not active because a payment is missing. Choose Manage billing.",
  /** The parent plan's stuck-state text: a purchase that Stripe does not show yet. */
  activating: "Activating your plan. Reload in a minute.",
  unreadable: "Retrofit could not load your plan right now. Try again in a few minutes.",
  manage: "Manage billing",
  busy: "Opening…",
  upgrade: (plan: string) => `Upgrade to ${plan}`,
  signIn: "Sign in",
  openAccount: "Open your account",
  /** The parent plan's stuck-state text, on /pricing. */
  cancelled: "Checkout was cancelled. Nothing was charged.",
  notStarted: "Paid plans have not started yet. Every feature is free until they do.",
  noPrice: "This plan has no price yet. Join the list to hear when it does.",
  subscribed: "Your account already has a plan. Change or cancel it with Manage billing on your account page.",
  noCustomer: "Your account has no plan to manage yet.",
  invalid: "Choose one of the plans on the pricing page.",
  limit: (retryAt: Date) => `You can open checkout or billing ${BILLING_ACTIONS_PER_HOUR} times an hour. Try again at ${hhmmUtc(retryAt)} UTC.`,
  signedOut: "Sign in to choose a plan.",
  tooLarge: "This request is too large.",
  unavailable: `Retrofit could not reach the payment service right now. Nothing was charged. Try again in a few minutes, or email ${LEAD_EMAIL}.`,
  crossOrigin: "Open Retrofit at its own address to choose a plan.",
} as const;

export const API_KEY_TEXT = {
  heading: "API keys",
  intro: "Use a key to score many sites from your own server with GET /api/score. Send it as Authorization: Bearer <key>. Never put a key in a web page.",
  none: "You have no API keys.",
  create: "Create an API key",
  revoke: "Revoke",
  busy: "Working…",
  item: (hint: string | null, createdOn: string) => `${hint ? `Key ending in ${hint}` : "Key"}, created on ${createdOn}`,
  created: "Copy your key now. Retrofit shows it only once.",
  revoked: "The key is revoked. It no longer works.",
  full: `An account holds at most ${MAX_API_KEYS} API keys. Revoke one first.`,
  notFound: "Retrofit could not find this key.",
  limit: (retryAt: Date) => `You can create ${API_KEY_CREATES_PER_HOUR} API keys an hour. Try again at ${hhmmUtc(retryAt)} UTC.`,
  signedOut: "Sign in again to change your API keys.",
  tooLarge: "This request is too large.",
  unavailable: `Retrofit could not change your API keys right now. Try again in a few minutes, or email ${LEAD_EMAIL}.`,
  crossOrigin: "Open Retrofit at its own address to change your API keys.",
} as const;
