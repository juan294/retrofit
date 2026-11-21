// Orders a home page's same-site links before the crawl takes its page budget (CRAWL_MAX_PAGES).
// Page order alone lets the first navigation menu fill the budget: on MDN the first 11 links are
// all HTML pages, on gov.uk the cookie page and the first ten topics. The rank is:
// 1. Content pages before utility pages (cookies, privacy, terms, sign-in, account, careers, press)
//    and before pages in another language than the home page (a language switcher).
// 2. Shallower pages (section hubs) before deeper ones; a task or content word (menu, hours,
//    contact, products, downloads, docs) counts as one level shallower.
// 3. Page order within a tie.
// Only the order changes: every link is kept, so the page budget and every fetch rule still apply.

export interface RankedLink {
  readonly url: string;
  readonly text: string;
}

const UTILITY =
  /\b(cookies?|privacy|terms|legal|accessibility|sitemap|careers?|jobs|press|newsroom|investors?|sign[- ]?in|log[- ]?in|sign[- ]?up|register|account|subscribe|newsletter|unsubscribe)\b/;
const TASK =
  /\b(menus?|food|drinks?|hours|opening|contact|about|prices?|pricing|plans|products?|shop|stores?|services?|book|bookings?|reserve|reservations?|orders?|locations?|visit|faq|support|catering|events?|downloads?|docs|documentation|guides?|learn)\b/;

// Common language codes, with an optional region ("pt-BR", "zh_CN"). Only a path's first segment counts.
const LOCALE = /^(ar|bg|bn|ca|cs|da|de|el|en|es|et|fa|fi|fr|he|hi|hr|hu|id|it|ja|ko|lt|lv|ms|nb|nl|no|pl|pt|ro|ru|sk|sl|sr|sv|th|tr|uk|vi|zh)(?:[-_][a-z]{2,4})?$/i;

function locale(path: string): string | null {
  const first = path.split("/").find(Boolean) ?? "";
  return LOCALE.test(first) ? first.toLowerCase() : null;
}

function words(link: RankedLink, path: string): string {
  return `${path.replace(/[/_.]+/g, " ")} ${link.text}`.toLowerCase();
}

/** The links in crawl order for the home page at `homeUrl`. A permutation of `links`; pure and deterministic. */
export function rankLinks<T extends RankedLink>(links: readonly T[], homeUrl?: string): T[] {
  const homeLocale = homeUrl ? locale(new URL(homeUrl).pathname) : null;
  return links
    .map((link, index) => {
      const path = new URL(link.url).pathname;
      const text = words(link, path);
      const depth = path.split("/").filter(Boolean).length;
      const linkLocale = locale(path);
      const otherLanguage = linkLocale !== null && linkLocale !== homeLocale;
      return { link, index, utility: otherLanguage || UTILITY.test(text) ? 1 : 0, level: depth - (TASK.test(text) ? 1 : 0) };
    })
    .sort((a, b) => a.utility - b.utility || a.level - b.level || a.index - b.index)
    .map((r) => r.link);
}
