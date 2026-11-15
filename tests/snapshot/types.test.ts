import { describe, expect, it } from "vitest";
import { extractPage } from "@/lib/fetch/extract";
import {
  PROBE_BODY_MAX_CHARS,
  SnapshotValidationError,
  mergeRecords,
  toSiteContent,
  validateSnapshot,
  type Probe,
  type Snapshot,
  type SnapshotPage,
} from "@/lib/snapshot/types";
import { ContentActions } from "../../public/preview-assets/content-actions.js";

const origin = "https://bakery.example";

function probe(path: string, status: number, body: string | null): Probe {
  return { url: `${origin}${path}`, status, contentType: body === null ? null : "text/plain", body, accessControlAllowOrigin: null };
}

function snapPage(path: string, html: string, headers: Record<string, string> = {}): SnapshotPage {
  return { ...extractPage({ url: `${origin}${path}`, html, headers }), status: 200, truncated: false };
}

function buildSnapshot(): Snapshot {
  const pages = [
    snapPage(
      "/",
      '<html lang="en"><head><title>Bakery</title><script type="application/ld+json">' +
        JSON.stringify({ "@type": "Product", "@id": "#rye", name: "Rye loaf", offers: { price: "5", priceCurrency: "USD" } }) +
        "</script></head><body><main>Fresh rye bread baked every morning.</main></body></html>",
    ),
    snapPage(
      "/hours",
      '<head><title>Hours</title><script type="application/ld+json">' +
        JSON.stringify([
          { "@type": "Product", "@id": "#rye", name: "Rye loaf" },
          { "@type": "OpeningHoursSpecification", dayOfWeek: "Monday", opens: "08:00", closes: "18:00" },
        ]) +
        "</script></head><main>Open Monday to Saturday.</main>",
    ),
    snapPage("/private", "<head><title>Staff</title></head><main>Staff only rye notes</main>", { "x-robots-tag": "noindex" }),
  ];
  return {
    version: "snapshot/v1",
    source: `${origin}/`,
    inputUrl: "https://www.bakery.example/",
    finalUrl: `${origin}/`,
    host: "bakery.example",
    fetchedAt: "2026-11-15T12:00:00.000Z",
    pages,
    probes: {
      agentManifest: probe("/agent-manifest.json", 404, null),
      llmsTxt: probe("/llms.txt", 200, "# Bakery"),
      sitemap: probe("/sitemap.xml", 200, "<urlset/>"),
      robots: probe("/robots.txt", 200, "User-agent: *"),
    },
    skipped: [{ url: `${origin}/cart`, reason: "excluded-path" }],
    records: mergeRecords(pages),
    excludedNoindex: [`${origin}/private`],
  };
}

function mutate(change: (s: Record<string, unknown>) => void): unknown {
  const s = structuredClone(buildSnapshot()) as unknown as Record<string, unknown>;
  change(s);
  return s;
}

describe("validateSnapshot", () => {
  // Fails if the validator rejects or alters a well-formed snapshot.
  it("accepts a valid snapshot", () => {
    const s = buildSnapshot();
    expect(validateSnapshot(JSON.parse(JSON.stringify(s)))).toEqual(s);
  });

  // Fails if unknown fields survive validation, so stored data could carry extra content.
  it("drops unknown fields", () => {
    const out = validateSnapshot(
      mutate((s) => {
        s.extra = "x";
        (s.pages as Record<string, unknown>[])[0]!.cookie = "secret";
      }),
    );
    expect(out).not.toHaveProperty("extra");
    expect(out.pages[0]).not.toHaveProperty("cookie");
  });

  const bad: [string, (s: Record<string, unknown>) => void][] = [
    ["a non-object", () => {}],
    ["a wrong version", (s) => void (s.version = "snapshot/v2")],
    ["a missing host", (s) => void delete s.host],
    ["a relative finalUrl", (s) => void (s.finalUrl = "/x")],
    ["a non-ISO fetchedAt", (s) => void (s.fetchedAt = "yesterday")],
    ["a non-array pages", (s) => void (s.pages = {})],
    ["an oversized page text", (s) => void ((s.pages as Record<string, unknown>[])[0]!.text = "a".repeat(20001))],
    ["a non-integer status", (s) => void ((s.pages as Record<string, unknown>[])[0]!.status = "200")],
    ["a missing probe", (s) => void delete (s.probes as Record<string, unknown>).robots],
    [
      "an oversized probe body",
      (s) => void ((s.probes as Record<string, Record<string, unknown>>).llmsTxt!.body = "a".repeat(PROBE_BODY_MAX_CHARS + 1)),
    ],
    ["a record without id", (s) => void delete ((s.records as Record<string, Record<string, unknown>[]>).products![0]!.id)],
    ["a record with an object value", (s) => void ((s.records as Record<string, Record<string, unknown>[]>).products![0]!.price = { a: 1 })],
    ["a bad skipped entry", (s) => void (s.skipped = [{ url: `${origin}/x` }])],
    ["a non-string excludedNoindex", (s) => void (s.excludedNoindex = [1])],
  ];
  for (const [name, change] of bad) {
    // Fails if the validator stops checking this part of the shape.
    it(`rejects ${name}`, () => {
      const input = name === "a non-object" ? "snapshot" : mutate(change);
      expect(() => validateSnapshot(input)).toThrow(SnapshotValidationError);
    });
  }
});

describe("mergeRecords", () => {
  // Fails if the same record on two pages is stored twice, or if the first occurrence does not win.
  it("deduplicates records by id across pages", () => {
    const s = buildSnapshot();
    expect(s.records.products).toHaveLength(1);
    expect(s.records.products?.[0]).toMatchObject({ id: "#rye", price: "5", url: `${origin}/` });
    expect(s.records.opening_hours).toHaveLength(1);
  });
});

describe("toSiteContent", () => {
  // Fails if the output gains or loses a field compared with the organizers' site-content.json.
  it("returns exactly the organizers' shape", () => {
    const content = toSiteContent(buildSnapshot());
    expect(Object.keys(content).sort()).toEqual(["fetchedAt", "pages", "records", "source"]);
    expect(content.source).toBe(`${origin}/`);
    expect(content.fetchedAt).toBe("2026-11-15T12:00:00.000Z");
    for (const p of content.pages) {
      expect(Object.keys(p).sort()).toEqual(["text", "title", "url"]);
    }
  });

  // Fails if noindex pages reach the public site-content.json.
  it("leaves out noindex pages", () => {
    const content = toSiteContent(buildSnapshot());
    expect(content.pages.map((p) => p.url)).toEqual([`${origin}/`, `${origin}/hours`]);
  });

  // Fails if the snapshot can be mutated through the returned object.
  it("returns a copy", () => {
    const s = buildSnapshot();
    const content = toSiteContent(s);
    content.records.products![0]!.name = "changed";
    expect(s.records.products?.[0]?.name).toBe("Rye loaf");
  });

  // Fails if the vendored content-actions.js cannot search or read records from the output.
  it("works with the vendored content actions", async () => {
    ContentActions.useSnapshot(toSiteContent(buildSnapshot()));
    const found = await ContentActions.search({ query: "rye bread" });
    expect(found.source).toBe(`${origin}/`);
    expect(found.fetchedAt).toBe("2026-11-15T12:00:00.000Z");
    expect(found.results.map((r: { url: string }) => r.url)).toEqual([`${origin}/`]);
    expect(found.results[0]?.title).toBe("Bakery");
    expect(found.results[0]?.excerpt).toContain("Fresh rye bread");
    const products = await ContentActions.records({ collection: "products", id: "#rye" });
    expect(products.records).toHaveLength(1);
    expect(products.records[0].name).toBe("Rye loaf");
  });
});
