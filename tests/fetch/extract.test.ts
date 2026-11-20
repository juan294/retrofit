import { describe, expect, it } from "vitest";
import { EMAIL_PLACEHOLDER, MAX_TEXT_CHARS, extractPage, scrubEmails } from "@/lib/fetch/extract";

const url = "https://bakery.example/menu";

function page(html: string, headers: Record<string, string> = { "content-type": "text/html" }) {
  return extractPage({ url, html, headers });
}

function ld(value: unknown): string {
  return `<script type="application/ld+json">${JSON.stringify(value)}</script>`;
}

describe("extractPage main content", () => {
  // Fails if extract stops preferring <main> over <article> and the rest of <body>.
  it("uses <main> when present", () => {
    const p = page(
      "<body><nav>Home Shop</nav><article>Article only</article><main><h1>Menu</h1><p>Sourdough loaf</p></main><footer>Footer</footer></body>",
    );
    expect(p.text).toBe("Menu Sourdough loaf");
  });

  // Fails if <article> is not the second choice when <main> is missing.
  it("falls back to <article>", () => {
    const p = page("<body><div>Sidebar text</div><article><p>Rye bread</p></article></body>");
    expect(p.text).toBe("Rye bread");
  });

  // Fails if the body fallback keeps navigation, header, footer, aside or non-content elements.
  it("falls back to <body> without nav, header, footer, aside, script, style, noscript and template", () => {
    const p = page(
      "<html><head><style>.a{}</style></head><body><header>Logo</header><nav>Links</nav>" +
        "<div><p>Open daily</p><script>var x = 1;</script><noscript>Enable JS</noscript>" +
        "<template><p>Hidden template</p></template></div><aside>Ad</aside><footer>Copyright</footer></body></html>",
    );
    expect(p.text).toBe("Open daily");
  });

  // Fails if block elements run together or whitespace is not collapsed.
  it("separates blocks and normalizes whitespace", () => {
    const p = page("<main><h2>Hours</h2><p>Mon\n\n   to   Fri</p><ul><li>Bread</li><li>Cake</li></ul>a<br>b</main>");
    expect(p.text).toBe("Hours Mon to Fri Bread Cake a b");
  });

  // Fails if the 20,000-character limit or the truncation flag is removed.
  it("truncates text at the limit and flags it", () => {
    const long = page(`<main><p>${"a".repeat(MAX_TEXT_CHARS + 500)}</p></main>`);
    expect(MAX_TEXT_CHARS).toBe(20000);
    expect(long.text).toHaveLength(MAX_TEXT_CHARS);
    expect(long.textTruncated).toBe(true);
    expect(page("<main>short</main>").textTruncated).toBe(false);
  });
});

describe("extractPage metadata", () => {
  // Fails if title, meta description or lang are read from the wrong place or not decoded to plain text.
  it("reads title, meta description and lang", () => {
    const p = page(
      '<html lang="es-MX"><head><title> Panadería &amp; Café </title><meta name="Description" content="Fresh  bread daily"></head><body><svg><title>icon</title></svg></body></html>',
    );
    expect(p.title).toBe("Panadería & Café");
    expect(p.description).toBe("Fresh bread daily");
    expect(p.lang).toBe("es-MX");
  });

  // Fails if missing metadata produces anything other than empty title and null description/lang.
  it("returns empty title and null description and lang when absent", () => {
    const p = page("<body>x</body>");
    expect(p.title).toBe("");
    expect(p.description).toBeNull();
    expect(p.lang).toBeNull();
  });

  // Fails if any header other than the three allowed ones is kept, or if keys are not lowercased.
  it("keeps only content-type, x-robots-tag and access-control-allow-origin", () => {
    const p = page("<main>x</main>", {
      "Content-Type": "text/html; charset=utf-8",
      "Set-Cookie": "session=secret",
      "Access-Control-Allow-Origin": "*",
      Server: "nginx",
    });
    expect(p.headers).toEqual({ "content-type": "text/html; charset=utf-8", "access-control-allow-origin": "*" });
  });
});

describe("extractPage privacy", () => {
  // Fails if email removal misses text, title, description, JSON-LD strings, labels or mailto links,
  // or if it also removes phone numbers or addresses.
  it("replaces emails everywhere and keeps phone numbers and addresses", () => {
    const p = page(
      '<html><head><title>Contact hello@bakery.example</title><meta name="description" content="Write to Orders.Team+x@Bakery.Example">' +
        ld({ "@type": "Product", name: "Gift box", description: "Ask owner@bakery.example", offers: { price: 10 } }) +
        "</head><body><main><p>Email jane.doe@mail.example or call +1 (555) 010-2000. Visit 12 Baker St, Springfield.</p>" +
        '<a href="mailto:jane.doe@mail.example?subject=hi">Mail jane.doe@mail.example</a><a href="tel:+15550102000">Call</a>' +
        '<form><label for="e">Your email (e.g. you@mail.example)</label><input id="e" name="email" type="email"></form>' +
        "</main></body></html>",
    );
    const all = JSON.stringify(p);
    expect(all).not.toMatch(/@(?:mail|bakery)\.example/i);
    expect(p.title).toBe(`Contact ${EMAIL_PLACEHOLDER}`);
    expect(p.description).toBe(`Write to ${EMAIL_PLACEHOLDER}`);
    expect(p.text).toContain(`Email ${EMAIL_PLACEHOLDER} or call +1 (555) 010-2000.`);
    expect(p.text).toContain("12 Baker St, Springfield.");
    expect(p.links.find((l) => l.href.startsWith("mailto:"))?.href).toBe(`mailto:${EMAIL_PLACEHOLDER}`);
    expect(p.links.find((l) => l.href.startsWith("tel:"))?.href).toBe("tel:+15550102000");
    expect(p.records.products?.[0]?.description).toBe(`Ask ${EMAIL_PLACEHOLDER}`);
    expect(p.forms[0]?.inputs[0]?.label).toBe(`Your email (e.g. ${EMAIL_PLACEHOLDER})`);
  });

  // Fails if any form value, placeholder-free default or checked state leaks into the extract.
  it("never records form values", () => {
    const p = page(
      '<main><form method="POST" action="/order"><input type="hidden" name="csrf" value="tok-SECRET-1">' +
        '<input name="qty" value="SECRET-2"><textarea name="note">SECRET-3</textarea>' +
        '<select name="size"><option value="SECRET-4" selected>Large</option></select></form></main>',
    );
    expect(JSON.stringify(p)).not.toMatch(/SECRET/);
  });
});

describe("extractPage forms and links", () => {
  // Fails if method, absolute action, label sources, input types or the hidden flag change.
  it("records form structure with labels", () => {
    const p = page(
      '<html><head><base href="https://bakery.example/shop/"></head><body><main>' +
        '<form method="POST" action="order?x=1"><label for="n">Name</label><input id="n" name="name">' +
        '<label>Phone <input name="phone" type="tel"></label>' +
        '<input name="q" aria-label="Search terms" type="search"><input type="hidden" name="csrf">' +
        '<textarea name="note"></textarea><select name="size"></select></form>' +
        "<form><input name='q'></form></main></body></html>",
    );
    expect(p.forms).toHaveLength(2);
    expect(p.forms[0]).toEqual({
      method: "post",
      action: "https://bakery.example/shop/order?x=1",
      inputs: [
        { name: "name", type: "text", label: "Name", hidden: false },
        { name: "phone", type: "tel", label: "Phone", hidden: false },
        { name: "q", type: "search", label: "Search terms", hidden: false },
        { name: "csrf", type: "hidden", label: null, hidden: true },
        { name: "note", type: "textarea", label: null, hidden: false },
        { name: "size", type: "select", label: null, hidden: false },
      ],
    });
    expect(p.forms[1]).toMatchObject({ method: "get", action: url });
  });

  // Fails if links are not absolute, lose the same-host flag, keep fragments or keep script URLs.
  it("records absolute links with a same-host flag", () => {
    const p = page(
      '<body><nav><a href="/about#team"> About  us </a></nav><main><a href="https://other.example/x">Partner</a>' +
        '<a href="javascript:alert(1)">Bad</a><a href="/about">About again</a><a href="https://BAKERY.example/cart">Cart</a></main></body>',
    );
    expect(p.links).toEqual([
      { href: "https://bakery.example/about", text: "About us", sameHost: true },
      { href: "https://other.example/x", text: "Partner", sameHost: false },
      { href: "https://bakery.example/cart", text: "Cart", sameHost: true },
    ]);
  });
});

describe("extractPage JSON-LD", () => {
  // Fails if invalid JSON-LD throws, is not counted, or @graph is not flattened.
  it("parses blocks, counts invalid ones and flattens @graph", () => {
    const p = page(
      "<head>" +
        ld({ "@context": "https://schema.org", "@graph": [{ "@type": "Bakery", name: "B" }, { "@type": "WebSite", name: "W" }] }) +
        ld([{ "@type": "Product", name: "P" }]) +
        '<script type="application/ld+json">{ not json</script>' +
        '<script type="application/ld+json; charset=utf-8">{"@type":"Event","name":"E","startDate":"2026-12-01"}</script>' +
        "</head><body>x</body>",
    );
    expect(p.jsonLdInvalid).toBe(1);
    expect(p.jsonLd.map((item) => (item as { name: string }).name)).toEqual(["B", "W", "P", "E"]);
  });
});

describe("extractPage records", () => {
  const html =
    "<head>" +
    ld({
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": "Product",
          "@id": "https://bakery.example/#sourdough",
          name: "Sourdough <b>loaf</b>",
          description: "<p>Fresh &amp; crusty</p>",
          sku: "SD-1",
          offers: { "@type": "Offer", price: 6.5, priceCurrency: "USD", availability: "https://schema.org/InStock" },
        },
        {
          "@type": "Bakery",
          name: "Bakery",
          telephone: "+1 555 010 2000",
          openingHoursSpecification: [
            { "@type": "OpeningHoursSpecification", dayOfWeek: ["https://schema.org/Monday", "Tuesday"], opens: "08:00", closes: "18:00" },
            { "@type": "OpeningHoursSpecification", dayOfWeek: "Sunday", opens: "09:00", closes: "13:00" },
          ],
          hasMenu: {
            "@type": "Menu",
            hasMenuSection: { "@type": "MenuSection", hasMenuItem: [{ "@type": "MenuItem", name: "Croissant", offers: { price: "3.00", priceCurrency: "USD" } }] },
          },
          makesOffer: { "@type": "Offer", name: "Catering", price: "100" },
        },
        { "@type": "Event", name: "Baking class", startDate: "2026-12-05T10:00", location: { "@type": "Place", name: "Main shop" } },
        { "@type": "Service", name: "Cake design", serviceType: "Custom cakes" },
      ],
    }) +
    ld({
      "@type": "Hotel",
      name: "Inn",
      containsPlace: [{ "@type": "HotelRoom", name: "Double room", description: "Two beds" }],
      makesOffer: { "@type": "Offer", price: "120", priceCurrency: "EUR", itemOffered: { "@type": "Suite", name: "Suite" } },
    }) +
    "</head><body>x</body>";

  // Fails if any required JSON-LD type stops producing records in its collection.
  it("collects records by collection", () => {
    const p = page(html);
    expect(Object.keys(p.records).sort()).toEqual(["events", "menu_items", "offers", "opening_hours", "products", "rooms", "services"]);
    expect(p.records.products).toEqual([
      {
        id: "https://bakery.example/#sourdough",
        type: "Product",
        name: "Sourdough loaf",
        description: "Fresh & crusty",
        url,
        sku: "SD-1",
        price: "6.5",
        priceCurrency: "USD",
        availability: "InStock",
      },
    ]);
    expect(p.records.menu_items?.[0]).toMatchObject({ type: "MenuItem", name: "Croissant", price: "3.00", priceCurrency: "USD", url });
    expect(p.records.events?.[0]).toMatchObject({ name: "Baking class", startDate: "2026-12-05T10:00", location: "Main shop" });
    expect(p.records.services?.[0]).toMatchObject({ name: "Cake design", serviceType: "Custom cakes" });
    expect(p.records.offers?.map((r) => r.name)).toEqual(["Catering"]);
    expect(p.records.rooms?.map((r) => [r.name, r.price ?? null])).toEqual([
      ["Double room", null],
      ["Suite", "120"],
    ]);
    expect(p.records.opening_hours?.map((r) => [r.dayOfWeek, r.opens, r.closes])).toEqual([
      [["Monday", "Tuesday"], "08:00", "18:00"],
      [["Sunday"], "09:00", "13:00"],
    ]);
  });

  // Fails if ids are not deterministic, not unique within a collection, or ignore the source url.
  it("gives stable unique ids that depend on the source url", () => {
    const first = page(html);
    const again = page(html);
    const elsewhere = extractPage({ url: "https://bakery.example/other", html, headers: {} });
    expect(again.records).toEqual(first.records);
    const hours = first.records.opening_hours ?? [];
    expect(new Set(hours.map((r) => r.id)).size).toBe(2);
    expect(elsewhere.records.menu_items?.[0]?.id).not.toBe(first.records.menu_items?.[0]?.id);
    // The JSON-LD @id is stable across pages.
    expect(elsewhere.records.products?.[0]?.id).toBe("https://bakery.example/#sourdough");
    for (const list of Object.values(first.records)) {
      for (const record of list) {
        expect(record.id.length).toBeLessThanOrEqual(200);
      }
    }
  });

  // Fails if names and descriptions keep HTML markup.
  it("stores names and descriptions as plain text", () => {
    const p = page(html);
    for (const list of Object.values(p.records)) {
      for (const record of list) {
        expect(`${record.name ?? ""}${record.description ?? ""}`).not.toMatch(/<\/?[a-z]/i);
      }
    }
  });
});

describe("extractPage noindex", () => {
  const html =
    '<head><meta name="robots" content="index, NOINDEX">' + ld({ "@type": "Product", name: "Secret" }) + "</head><main>Private text</main>";

  // Fails if a robots meta noindex no longer excludes text and records.
  it("excludes text and records for a robots meta noindex", () => {
    const p = page(html);
    expect(p.noindex).toBe(true);
    expect(p.text).toBe("");
    expect(p.records).toEqual({});
  });

  // Fails if the x-robots-tag header is ignored, or if a directive scoped to another bot applies to us.
  it("honors x-robots-tag for all bots and RetrofitBot only", () => {
    expect(page("<main>t</main>", { "x-robots-tag": "noindex" }).noindex).toBe(true);
    expect(page("<main>t</main>", { "X-Robots-Tag": "RetrofitBot: none" }).noindex).toBe(true);
    const other = page("<main>t</main>", { "x-robots-tag": "otherbot: noindex, nofollow" });
    expect(other.noindex).toBe(false);
    expect(other.text).toBe("t");
    expect(page("<main>t</main>", { "x-robots-tag": "unavailable_after: 2027-01-01" }).noindex).toBe(false);
    expect(page('<head><meta name="googlebot" content="noindex"></head><main>t</main>').noindex).toBe(false);
  });
});

describe("scrubEmails on hostile input", () => {
  // Fails if the email pattern goes back to unbounded repetitions (quadratic time on long word runs).
  it("handles a 1 MB run of word characters with an @ in linear time", () => {
    const input = `${"x".repeat(1_000_000)}@${"y".repeat(1_000_000)}`;
    const t = performance.now();
    scrubEmails(input);
    expect(performance.now() - t).toBeLessThan(1500);
  });

  it("still removes ordinary addresses", () => {
    expect(scrubEmails("write to hello@crumb-and-crust.example today")).toBe("write to [email removed] today");
  });
});

describe("extractor output always validates", () => {
  // Fails if the extractor emits a value the snapshot validator refuses (the whole crawl would fail).
  it("accepts a long href, deep JSON-LD, a long @type and an encoded email", async () => {
    const { validateSnapshot, SNAPSHOT_VERSION } = await import("@/lib/snapshot/types");
    let deep: unknown = { "@type": "Thing", name: "leaf" };
    for (let i = 0; i < 40; i++) deep = { "@type": "Thing", child: deep };
    const html = `<html><head><title>t</title>
      <script type="application/ld+json">${JSON.stringify(deep)}</script>
      <script type="application/ld+json">${JSON.stringify({ "@type": `${"X".repeat(190)}Event`, name: "Long type" })}</script>
      </head><body><main>
      <a href="/a?${"q".repeat(4800)}">long</a>
      <a href="/subscribe?email=jane%40example.com">sub</a>
      <form action="/f?${"r".repeat(5000)}"><input name="x" aria-label="x"></form>
      </main></body></html>`;
    const page = { ...extractPage({ url: "https://shop.example/", html, headers: {} }), status: 200, truncated: false };
    const empty = { url: "https://shop.example/x", status: null, contentType: null, body: null, accessControlAllowOrigin: null };
    const snapshot = validateSnapshot({
      version: SNAPSHOT_VERSION, source: page.url, inputUrl: page.url, finalUrl: page.url, host: "shop.example",
      fetchedAt: new Date(0).toISOString(), pages: [page], probes: { agentManifest: empty, llmsTxt: empty, sitemap: empty, robots: empty },
      skipped: [], records: page.records, excludedNoindex: [],
    });
    expect(JSON.stringify(snapshot)).not.toContain("jane%40example.com");
    expect(snapshot.pages[0]!.links.every((l) => l.href.length <= 4096)).toBe(true);
  });
});
