// Retrofit's own discovery data: the public pages, the home page JSON-LD and /llms.txt.
// Retrofit scores other sites on these signals (score/v1), so its own site carries them too.

/** Public pages, in sitemap and llms.txt order. Private pages (judges, results, previews) stay out. */
export const OWN_PAGES: readonly { path: string; title: string; summary: string }[] = [
  { path: "/", title: "Retrofit", summary: "Paste a website address to score how ready it is for AI agents and try a private preview agent built from its public pages." },
  { path: "/conformance", title: "Conformance fixtures", summary: "Retrofit's conformance network and its partner fixtures for the open agentic web specification." },
  { path: "/bot", title: "How RetrofitBot reads your site", summary: "What RetrofitBot fetches, which pages it skips, and how it follows robots rules." },
];

export const CONTACT_URL = "https://github.com/juan294/retrofit/issues";
export const SOURCE_URL = "https://github.com/juan294/retrofit";

/** The home page's JSON-LD: the organization and the free agent-readiness service it offers. */
export function retrofitJsonLd(origin: string): Record<string, unknown>[] {
  const organization = { "@type": "Organization", name: "Retrofit", url: `${origin}/`, sameAs: [SOURCE_URL] };
  return [
    { "@context": "https://schema.org", ...organization },
    {
      "@context": "https://schema.org",
      "@type": "Service",
      name: "Agent readiness check and preview agent",
      description: "Scores how ready a public website is for AI agents and builds a private preview agent that runs in the browser.",
      url: `${origin}/`,
      provider: organization,
      offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
    },
  ];
}

/** /llms.txt in the llmstxt.org format: a title, a one-line summary and links to the public pages. */
export function llmsText(origin: string): string {
  const pages = OWN_PAGES.map((p) => `- [${p.title}](${origin}${p.path}): ${p.summary}`).join("\n");
  return [
    "# Retrofit",
    "",
    "> Retrofit scores how ready a public website is for AI agents and builds a private preview agent for it that runs in the browser, following the open agentic web specification.",
    "",
    "## Pages",
    "",
    pages,
    "",
    "## Agents",
    "",
    `- [Agent manifest](${origin}/agent-manifest.json): Retrofit's own agent network and its conformance network.`,
    "",
    "## Source",
    "",
    `- [Source code](${SOURCE_URL}): Apache-2.0.`,
    "",
  ].join("\n");
}
