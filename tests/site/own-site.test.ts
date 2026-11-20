import { describe, expect, it } from "vitest";
import { CHECKS } from "@/lib/score/checks";
import { SNAPSHOT_VERSION, type JsonValue, type Snapshot, type SnapshotPage } from "@/lib/snapshot/types";
import { llmsText, OWN_PAGES, retrofitJsonLd } from "@/lib/site/own-site";
import robots from "@/app/robots";
import sitemap from "@/app/sitemap";
import { GET as llmsGet } from "@/app/llms.txt/route";
import { getConfig } from "@/lib/config";

const ORIGIN = "https://retrofit.example";

function homeWith(jsonLd: JsonValue[]): Snapshot {
  const page: SnapshotPage = {
    url: `${ORIGIN}/`, status: 200, truncated: false, title: "Retrofit", description: "d", lang: "en", text: "", textTruncated: false,
    noindex: false, headers: {}, jsonLd, jsonLdInvalid: 0, forms: [], links: [], records: {},
  };
  const probe = { url: `${ORIGIN}/x`, status: 404, contentType: "text/plain", body: "", accessControlAllowOrigin: null };
  return {
    version: SNAPSHOT_VERSION, source: `${ORIGIN}/`, inputUrl: `${ORIGIN}/`, finalUrl: `${ORIGIN}/`, host: "retrofit.example",
    fetchedAt: "2026-11-20T10:00:00.000Z", pages: [page],
    probes: { robots: probe, agentManifest: probe, llmsTxt: probe, sitemap: probe },
    skipped: [], records: {}, excludedNoindex: [],
  };
}

describe("Retrofit's own site, scored by Retrofit", () => {
  // Fails if the home page's structured data stops satisfying score/v1's three structured-data checks.
  it("the home page JSON-LD passes data.jsonld, data.business and data.offers", () => {
    const s = homeWith(retrofitJsonLd(ORIGIN) as JsonValue[]);
    expect(CHECKS["data.jsonld"](s).result).toBe("pass");
    expect(CHECKS["data.business"](s).result).toBe("pass");
    expect(CHECKS["data.offers"](s).result).toBe("pass");
  });

  // Fails if robots.txt stops allowing agents or stops declaring the sitemap (disc.robots-ai, disc.sitemap).
  it("robots allows every agent and declares the sitemap", () => {
    const r = robots();
    const origin = getConfig().publicOrigin;
    // Private pages (results, previews, the judge page) are visitor-owned; crawlers have no reason to request them.
    expect(r.rules).toEqual([{ userAgent: "*", allow: "/", disallow: ["/r/", "/p/", "/judges"] }]);
    expect(r.sitemap).toBe(`${origin}/sitemap.xml`);
  });

  // Fails if a public page drops out of the sitemap or a private one (judges, results) enters it.
  it("the sitemap lists the public pages only", () => {
    const origin = getConfig().publicOrigin;
    const urls = sitemap().map((e) => e.url);
    expect(urls).toEqual(OWN_PAGES.map((p) => `${origin}${p.path}`));
    expect(urls.some((u) => /\/judges|\/r\/|\/p\//.test(u))).toBe(false);
  });

  // Fails if /llms.txt is not plain text or loses its title and page links (disc.llms-txt).
  it("llms.txt is Markdown text with a title, a summary and every public page", async () => {
    const res = llmsGet();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/plain/);
    const body = await res.text();
    expect(body).toBe(llmsText(getConfig().publicOrigin));
    expect(body.startsWith("# Retrofit\n\n> ")).toBe(true);
    for (const p of OWN_PAGES) expect(body).toContain(`(${getConfig().publicOrigin}${p.path})`);
  });
});
