// Plain-language fixes for the score/v1 checks, and the "fix these first" selection.
import { CHECK_DEFINITIONS, type CheckId } from "./checks";

/** One sentence per check: what a site owner can change so the check passes. */
export const FIX_HINTS: Record<CheckId, string> = {
  "aw.manifest": "Publish /agent-manifest.json naming your agent network, so other agents and browsers can find it.",
  "aw.network-valid": "Make the network file that your manifest points to load and pass the runtime's validation.",
  "aw.cors": "Serve /agent-manifest.json with Access-Control-Allow-Origin: * so agents on other sites can read it.",
  "disc.robots-agents": "Let AI agents read your public pages: remove the Disallow: / rules for them in robots.txt.",
  "disc.sitemap": "Add a sitemap.xml and declare it in robots.txt with a Sitemap: line.",
  "disc.llms-txt": "Add /llms.txt: a short Markdown summary of your site with links to its most useful pages.",
  "read.server-text": "Put your main text in the HTML the server sends, because many agents do not run JavaScript.",
  "read.title-description": "Give the home page a clear title and a meta description.",
  "read.lang": "Declare the page language, for example <html lang=\"en\">.",
  "data.jsonld": "Add schema.org JSON-LD to your pages so agents can read your facts without guessing.",
  "data.business": "Describe your business in JSON-LD: an Organization or LocalBusiness with its name and its URL or address.",
  "data.offers": "List what you offer in JSON-LD as Product, Offer, MenuItem, Event or Service.",
  "data.hours": "Add your opening hours to your LocalBusiness JSON-LD as OpeningHoursSpecification.",
  "act.form-labels": "Give every form field a label, so an agent knows what to type where.",
  "act.task-links": "Link from the home page to the pages where people act: contact, booking, ordering or the menu.",
  "sec.https": "Serve the whole site over HTTPS.",
};

const ORDER = new Map<string, number>(CHECK_DEFINITIONS.map((d, i) => [d.id, i]));

/** The failed checks worth the most points, at most `n`, ties in definition order. */
export function fixFirst<T extends { id: string; weight: number; result: string }>(checks: readonly T[], n = 3): T[] {
  return checks
    .filter((c) => c.result === "fail")
    .sort((a, b) => b.weight - a.weight || (ORDER.get(a.id) ?? 99) - (ORDER.get(b.id) ?? 99))
    .slice(0, n);
}
