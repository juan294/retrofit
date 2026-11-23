import { describe, expect, it } from "vitest";
import { createFetchGuard, REDIRECT_BLOCKED_TEXT } from "@/lib/preview/fetch-guard";

const PAGE = "https://retrofit.example";

describe("the fetch guard on a published page", () => {
  // Fails if a published site's agent files may follow a redirect (a /p/ preview's may not): the file an agent runs must come from its own path.
  it.each(["/s/shop.example.com/agent-manifest.json", "/s/shop.example.com/site_shop_example_com.network.json", "/s/shop.example.com/site-content.json", "/s/shop.example.com/links.json", "/s/shop.example.com/content-actions.js"])(
    "refuses a redirect from %s",
    async (path) => {
      const seen: RequestInit[] = [];
      const guard = createFetchGuard({ pageOrigin: PAGE, originalFetch: async (_input, init) => (seen.push(init ?? {}), new Response(null, { status: 302, headers: { location: "/elsewhere" } })) });
      await expect(guard.fetch(path)).rejects.toThrow(REDIRECT_BLOCKED_TEXT(PAGE));
      expect(seen[0]?.redirect).toBe("manual");
    },
  );

  // Fails if the rule is a prefix test that also covers other pages (for example /sign-in or /sitemap.xml).
  it("leaves other same-origin paths alone", async () => {
    const seen: RequestInit[] = [];
    const guard = createFetchGuard({ pageOrigin: PAGE, originalFetch: async (_input, init) => (seen.push(init ?? {}), new Response("ok")) });
    for (const path of ["/sign-in", "/sitemap.xml", "/api/s/x"]) await guard.fetch(path);
    expect(seen.every((i) => i.redirect === undefined)).toBe(true);
  });
});
