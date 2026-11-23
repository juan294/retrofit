import { signInHref } from "@/lib/accounts/return-to";
import { isBillingUrl } from "@/lib/billing/urls";
import { BILLING_TEXT as T } from "@/lib/site/billing-texts";
import { localizeRetry } from "../analysis/retry-time";

/** What the page does with an answer: navigate, or show a text (with the next step's link). */
export type BillingStep = { readonly go: string } | { readonly text: string; readonly href?: string; readonly linkText?: string };

/** The answer of POST /api/billing/checkout or /portal. Only a URL of Stripe's own pages is ever followed (urls.ts). */
export function billingStep(status: number, raw: unknown, fixtureOrigin: string | null, returnTo: string): BillingStep {
  const body = (raw ?? {}) as { url?: unknown; message?: unknown; retryAt?: unknown; portal?: unknown };
  if (status === 200 && isBillingUrl(body.url, fixtureOrigin)) return { go: body.url };
  const text = typeof body.message === "string" ? localizeRetry(body.message, typeof body.retryAt === "string" ? body.retryAt : undefined) : T.unavailable;
  if (status === 401) return { text, href: signInHref(returnTo), linkText: T.signIn };
  if (body.portal === true) return { text, href: "/account", linkText: T.openAccount };
  return { text };
}
