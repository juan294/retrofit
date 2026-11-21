import { describe, expect, it } from "vitest";
import { rankLinks } from "@/lib/fetch/rank";

const at = (paths: [string, string][]) => paths.map(([p, text]) => ({ url: `https://bakery.example${p}`, text }));
const paths = (ranked: { url: string }[]) => ranked.map((l) => new URL(l.url).pathname);

describe("rankLinks", () => {
  // Fails if a cookie, privacy, terms, sign-in, account or careers page can take a page slot before a content page.
  it("puts utility pages after every content page", () => {
    const ranked = rankLinks(
      at([
        ["/help/cookies", "change your cookie settings"],
        ["/privacy-policy", "Privacy"],
        ["/blog/2024/05/new-oven/photos", "Photos of the new oven"],
        ["/terms", "Terms of use"],
        ["/sign-in-rewards", "Rewards: sign in"],
        ["/careers", "Work with us"],
        ["/my-orders", "Your account"],
      ]),
    );
    // The order among utility pages is not part of this rule; only that they all come last.
    expect(paths(ranked)[0]).toBe("/blog/2024/05/new-oven/photos");
    expect(new Set(paths(ranked).slice(1))).toEqual(new Set(["/help/cookies", "/privacy-policy", "/terms", "/sign-in-rewards", "/careers", "/my-orders"]));
  });

  // Fails if a deep page in the first menu can push section hubs out of the page budget (MDN, gov.uk).
  it("puts shallower pages first and keeps page order within a depth", () => {
    const ranked = rankLinks(
      at([
        ["/docs/html/elements", "Elements"],
        ["/docs/html/attributes", "Attributes"],
        ["/docs/html", "HTML"],
        ["/docs/css/properties", "Properties"],
        ["/docs/css", "CSS"],
        ["/docs/javascript", "JavaScript"],
      ]),
    );
    expect(paths(ranked)).toEqual(["/docs/html", "/docs/css", "/docs/javascript", "/docs/html/elements", "/docs/html/attributes", "/docs/css/properties"]);
  });

  // Fails if a task page (menu, hours, contact, products, downloads) does not move ahead of a same-depth or one-deeper page.
  it("moves task and content pages one level up", () => {
    const ranked = rankLinks(
      at([
        ["/story", "Our story"],
        ["/press/kit", "Press kit"],
        ["/visit/opening-hours", "Opening hours"],
        ["/menu", "Menu"],
        ["/downloads/macos", "macOS"],
      ]),
    );
    expect(paths(ranked)).toEqual(["/menu", "/story", "/visit/opening-hours", "/downloads/macos", "/press/kit"]);
  });

  // Fails if a language switcher (shallow links to other locales) can fill the page budget (MDN).
  it("puts pages in another language than the home page with the utility pages", () => {
    const links = ["/de/", "/es/", "/pt-BR/", "/en-US/docs/Web/HTML", "/en-US/about", "/zh-CN/"].map((p) => ({ url: `https://docs.example${p}`, text: "x" }));
    const ranked = paths(rankLinks(links, "https://docs.example/en-US/"));
    expect(ranked.slice(0, 2)).toEqual(["/en-US/about", "/en-US/docs/Web/HTML"]);
    expect(new Set(ranked.slice(2))).toEqual(new Set(["/de/", "/es/", "/pt-BR/", "/zh-CN/"]));
    // Without a locale on the home page, a locale path is still another language.
    expect(paths(rankLinks(at([["/fr/", "Français"], ["/menu", "Menu"]]), "https://bakery.example/"))).toEqual(["/menu", "/fr/"]);
  });

  // Fails if ranking drops, duplicates or invents a link, or depends on anything but its input.
  it("returns a permutation of its input, deterministically", () => {
    const input = at([
      ["/a/b/c", "x"],
      ["/terms", "Terms"],
      ["/menu", "Menu"],
      ["/", "Home"],
      ["/a", "A"],
    ]);
    const once = rankLinks(input);
    expect(rankLinks(input)).toEqual(once);
    expect([...once].sort((x, y) => x.url.localeCompare(y.url))).toEqual([...input].sort((x, y) => x.url.localeCompare(y.url)));
  });
});
