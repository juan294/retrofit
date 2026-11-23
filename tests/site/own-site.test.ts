import { describe, expect, it } from "vitest";
import { CHECKS } from "@/lib/score/checks";
import { SNAPSHOT_VERSION, type JsonValue, type Snapshot, type SnapshotPage } from "@/lib/snapshot/types";
import { leadMailto, llmsText, OWN_PAGES, retrofitJsonLd } from "@/lib/site/own-site";
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
    // Private pages (results, previews, the judge page, unsubscribe links) are visitor-owned; crawlers have no reason to request them.
    expect(r.rules).toEqual([{ userAgent: "*", allow: "/", disallow: ["/r/", "/p/", "/judges", "/unsubscribe", "/account", "/auth/", "/sign-in"] }]);
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

describe("installation inquiries", () => {
  it("builds one email subject for a scored host, including reserved characters and international names", () => {
    const to = "mailto:retrofit@thecreativetoken.com?subject=";
    expect(leadMailto("demo & test#1", 37)).toBe(to + "Retrofit%20install%20for%20demo%20%26%20test%231%20(score%2037)");
    expect(leadMailto("café.example", 0)).toBe(to + "Retrofit%20install%20for%20xn--caf-dma.example%20(score%200)");
    expect(leadMailto("sample.test", null)).toBe(to + "Retrofit%20install%20for%20sample.test%20(score%20unavailable)");
    expect(leadMailto()).toBe(to + "Retrofit%20install%20for%20my%20site");
  });

  it("publishes the installation service and its email in JSON-LD and llms.txt", () => {
    const services = JSON.parse(JSON.stringify(retrofitJsonLd(ORIGIN))).filter((node: { "@type": string }) => node["@type"] === "Service");
    expect(services).toHaveLength(2);
    expect(services).toContainEqual(expect.objectContaining({
      name: "Done-for-you agentic website setup",
      provider: expect.objectContaining({ "@type": "Organization", name: "Retrofit", contactPoint: expect.objectContaining({ "@type": "ContactPoint", email: "retrofit@thecreativetoken.com" }) }),
    }));
    expect(llmsText(ORIGIN)).toMatch(/## Contact\n\n[^\n]*retrofit@thecreativetoken\.com/);
  });
});

describe("pricing, privacy and terms pages", () => {
  const NEW_PAGES = ["/pricing", "/privacy", "/terms"];

  // Fails if one of the new public pages is missing from OWN_PAGES, and so from the sitemap and llms.txt.
  it("are public pages in the sitemap and llms.txt", () => {
    const origin = getConfig().publicOrigin;
    const urls = sitemap().map((e) => e.url);
    const body = llmsText(origin);
    for (const path of NEW_PAGES) {
      expect(OWN_PAGES.map((p) => p.path)).toContain(path);
      expect(urls).toContain(`${origin}${path}`);
      expect(body).toContain(`(${origin}${path})`);
    }
  });

  // Fails if robots.txt blocks a new public page, or stops blocking the unsubscribe links (they carry a token).
  it("are allowed by robots while unsubscribe links are not", () => {
    const disallow = robots().rules;
    const rules = Array.isArray(disallow) ? disallow : [disallow];
    const blocked = rules.flatMap((r) => (Array.isArray(r.disallow) ? r.disallow : r.disallow ? [r.disallow] : []));
    for (const path of NEW_PAGES) expect(blocked.some((d) => path.startsWith(d))).toBe(false);
    expect(blocked).toContain("/unsubscribe");
  });
});

describe("account pages and robots", () => {
  // Fails if a crawler is invited to the sign-in, confirm or account pages (they are private and the confirm link carries a token).
  it("robots disallows /account, /auth/ and /sign-in, and no account page is listed as public", () => {
    const rules = robots().rules;
    const blocked = (Array.isArray(rules) ? rules : [rules]).flatMap((r) => (Array.isArray(r.disallow) ? r.disallow : r.disallow ? [r.disallow] : []));
    for (const path of ["/account", "/auth/", "/sign-in"]) expect(blocked).toContain(path);
    for (const path of ["/account", "/account/reports/x", "/auth/confirm", "/sign-in"]) expect(blocked.some((d) => path.startsWith(d))).toBe(true);
    expect(OWN_PAGES.map((p) => p.path).filter((p) => /account|auth|sign-in/.test(p))).toEqual([]);
  });
});
