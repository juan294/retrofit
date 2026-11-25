import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import AnalysisNotFound from "@/app/r/[id]/not-found";
import PublishedNotFound from "@/app/s/[host]/not-found";
import { SiteNav } from "@/components/SiteNav";
import { SitePage } from "@/components/SitePage";

const links = (html: string) => [...html.matchAll(/<a [^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/g)].map((m) => [m[1], m[2]]);
const NAV = [["/", "Retrofit"], ["/pricing", "Pricing"], ["/account", "Account"]];

describe("the site navigation (UX-H1)", () => {
  // Fails if sign-in, the account or the plans have no link on a page, or the navigation needs a request: it renders
  // outside one here, so it reads no cookie and no account, and is the same for every visitor.
  it("links to the home page, the plans and the account, with no account read", () => {
    const html = renderToStaticMarkup(createElement(SiteNav));
    expect(html).toMatch(/^<nav aria-label="Retrofit"/);
    expect(links(html)).toEqual(NAV);
    expect(html).not.toContain("<p");
  });

  // Fails if a text page, or the page a lost analysis or an unpublished host shows, is a dead end.
  it("is on every text page and on the two not-found pages", () => {
    for (const el of [createElement(SitePage, { title: "T", children: null }), createElement(AnalysisNotFound), createElement(PublishedNotFound)]) expect(links(renderToStaticMarkup(el)).slice(0, 3)).toEqual(NAV);
  });
});
