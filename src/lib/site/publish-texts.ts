// Copy for publishing: the publish controls in a claim panel on /account, the publish API answers and
// the public page /s/<host>, in one module so a UI pass can restyle them without touching their logic.

import type { RefreshError } from "@/lib/accounts/data";
import { PUBLISH_PER_HOUR, PUBLISH_TRIES_PER_HOUR } from "@/lib/accounts/limits";
import { hhmmUtc } from "@/lib/analysis/texts";
import { LEAD_EMAIL } from "./own-site";

export const PUBLISH_TEXT = {
  intro: "Publish this site's agent on Retrofit: a public page with its report and the agent, and a badge for your site. Visitors use their own AI key.",
  publish: "Publish",
  refresh: "Refresh",
  tryAgain: "Try again",
  unpublish: "Unpublish",
  publicPage: "Public page:",
  savedOn: (date: string) => `It shows the site as Retrofit read it on ${date}. To update it, analyze the site again, then choose Refresh.`,
  lastRefreshFailed: "The last refresh failed, and the public page did not change.",
  paused: "Your published page and badge are paused until a check passes.",
  badgeHeading: "Show the badge on your site with this HTML:",

  published: "Published. Anyone can open the public page now.",
  refreshed: "Refreshed. The public page shows the newest analysis.",
  unpublished: "Unpublished. The public page and the badge are gone.",
  noClaim: (host: string) => `Claim and verify ${host} first. Only its verified owner can publish it.`,
  notVerified: (host: string) => `Your claim for ${host} is not verified right now. Choose Check again, then publish.`,
  /** A publish that failed, and the stored code of the last failed refresh, as the account page shows it. */
  refreshError: {
    no_analysis: (host: string) => `Analyze ${host} first, while you are signed in. Then publish it here.`,
    generation_failed: (host: string) => `Retrofit could not build a working agent from the newest analysis of ${host}, so nothing was published from it.`,
    too_large: (host: string) => `The newest analysis of ${host} is too large to publish.`,
  } satisfies Record<RefreshError, (host: string) => string>,
  notNewer: (host: string) => `The published page already shows your newest analysis of ${host}. Analyze it again, then refresh.`,
  /** Too soon after the last read a new analysis would bring the same read. `from`: when a new read is possible for the verified owner. */
  sameRead: (host: string, minutes: number, from: Date) =>
    `The published page already shows your newest analysis of ${host}. Retrofit reads a site again for its verified owner ${minutes} minutes after the last read, so a new analysis brings nothing newer before ${hhmmUtc(from)} UTC. Analyze it again after that, then refresh.`,
  notPublished: (host: string) => `${host} is not published.`,
  limit: (retryAt: Date) => `You can publish or refresh ${PUBLISH_PER_HOUR} times an hour. Try again at ${hhmmUtc(retryAt)} UTC.`,
  tries: (retryAt: Date) => `You tried to publish or refresh more than ${PUBLISH_TRIES_PER_HOUR} times this hour. Try again at ${hhmmUtc(retryAt)} UTC.`,
  invalid: "Choose one of your verified sites.",
  signedOut: "Sign in again to publish your sites.",
  tooLarge: "This request is too large.",
  unavailable: `Retrofit could not change your published sites right now. Try again in a few minutes, or email ${LEAD_EMAIL}.`,
  crossOrigin: "Open Retrofit at its own address to publish your sites.",
} as const;

export const PUBLISHED_PAGE_TEXT = {
  metaTitle: (host: string) => `${host} agent report · Retrofit`,
  metaDescription: (host: string) => `How ready ${host} is for AI agents, and an agent that answers questions from its public pages. Published by its verified owner.`,
  title: (host: string) => `Agent readiness of ${host}`,
  publishedBy: (host: string, date: string) => `Published by the verified owner of ${host}. Saved on ${date}.`,
  agentTitle: (host: string) => `Ask ${host}`,
  ownKey: "This agent runs in your browser with your own AI key. Your messages and the page data it reads go to the AI provider you choose. Your key goes only to that provider, never to Retrofit.",
  notFoundTitle: "No published agent here",
  notFound: "This site has no published agent on Retrofit, or its owner has paused or removed it.",
  analyze: "Analyze a site",
  filesNotFound: "This published agent is not available.",
  unavailable: "Retrofit could not load this published agent right now. Try again in a few minutes.",
  unavailableTitle: "Temporarily unavailable",
  tryAgain: "Try again",
} as const;
