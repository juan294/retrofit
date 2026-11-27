import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { emojiParts, hasEmoji, ICONS, roleIcon } from "../../public/brand/runtime-icons.js";

describe("emojiParts", () => {
  // Fails if an emoji that the vendored runtime writes (public/runtime/ui.js) reaches the page instead of an icon.
  it("turns each emoji of the runtime into its icon, with or without the variation selector", () => {
    const cases: Array<[string, string]> = [
      ["\u{1F9ED}", "concierge"],
      ["\u{1F3E2}", "partner"],
      ["\u{1F310}", "service"],
      ["\u{1F517}", "link"],
      ["⚙", "tool"],
      ["⚙️", "tool"],
      ["⚠", "warning"],
      ["⚠️", "warning"],
      ["↩", "back"],
    ];
    for (const [emoji, icon] of cases) expect(emojiParts(emoji), emoji).toEqual([{ icon }]);
    expect(emojiParts("⚠️ LLM HTTP 500: busy")).toEqual([{ icon: "warning" }, { text: " LLM HTTP 500: busy" }]);
    expect(emojiParts("Open ⚙ AI model settings")).toEqual([{ text: "Open " }, { icon: "tool" }, { text: " AI model settings" }]);
  });

  // Fails if another emoji stays in the text, or its removal leaves a double or a leading space.
  it("removes other emoji with one space next to them", () => {
    expect(emojiParts("Great \u{1F44D} thanks")).toEqual([{ text: "Great thanks" }]);
    expect(emojiParts("\u{1F600} Hello")).toEqual([{ text: "Hello" }]);
    expect(emojiParts("Done \u{1F389}")).toEqual([{ text: "Done" }]);
    expect(emojiParts("a \u{1F44D}\u{1F44D} b")).toEqual([{ text: "a b" }]);
    expect(emojiParts("a \u{1F44D} \u{1F44D} b")).toEqual([{ text: "a b" }]);
    expect(emojiParts("\u{1F600}")).toEqual([]);
    // A text node between inline elements keeps the space that separates it from them.
    expect(emojiParts(" \u{1F600} there")).toEqual([{ text: " there" }]);
    expect(emojiParts("Done \u{1F389} ")).toEqual([{ text: "Done " }]);
    // A removed emoji next to a known one does not take the known one's space.
    expect(emojiParts("\u{1F600} \u26A0 Busy")).toEqual([{ icon: "warning" }, { text: " Busy" }]);
    for (const emoji of ["\u{1F44D}\u{1F3FD}", "\u{1F468}‍\u{1F469}‍\u{1F467}", "\u{1F1FA}\u{1F1F8}", "1️⃣", "❤️"]) {
      expect(emojiParts(`a ${emoji} b`), emoji).toEqual([{ text: "a b" }]);
    }
  });

  // Fails if an unknown emoji in an icon place (a brand or widget icon) leaves the place empty or keeps the emoji.
  it("puts the mark in an icon place for an unknown emoji", () => {
    expect(emojiParts("\u{1F370}", { iconPlace: true })).toEqual([{ icon: "mark" }]);
    expect(emojiParts("\u{1F3E2}", { iconPlace: true })).toEqual([{ icon: "partner" }]);
  });

  // Fails if ordinary characters are taken for emoji: digits, signs that are text by default, accents and CJK.
  it("keeps text without emoji unchanged", () => {
    for (const text of ["© 2026 Bakery®™", "Call 555 0100 #3 *", "✓ Allowed ✕ Declined ×", "Café 東京 → next"]) {
      expect(hasEmoji(text), text).toBe(false);
      expect(emojiParts(text), text).toEqual([{ text }]);
    }
  });
});

describe("roleIcon", () => {
  // The runtime gives every brand without its own emoji the compass, also a partner it has contacted
  // (public/runtime/ui.js splitBrand). Fails if a partner network shows the concierge icon.
  it("keeps the concierge icon for the site's own agent and gives other agents the partner icon", () => {
    expect(roleIcon("concierge", "your concierge")).toBe("concierge");
    expect(roleIcon("concierge", "your concierge \u00B7 localhost:3010")).toBe("concierge");
    expect(roleIcon("concierge", "partner network")).toBe("partner");
    expect(roleIcon("concierge", "partner network \u00B7 demo-harbor.example/harbor_tours")).toBe("partner");
    expect(roleIcon("concierge", null)).toBe("concierge");
    expect(roleIcon("service", "hosted MCP server")).toBe("service");
  });
});

describe("ICONS", () => {
  // Fails if an icon is missing for a name that emojiParts can return, or an icon draws nothing.
  it("draws every icon that emojiParts can return", () => {
    for (const name of ["concierge", "partner", "service", "link", "tool", "warning", "back", "mark"]) {
      const shapes = ICONS[name as keyof typeof ICONS];
      expect(shapes?.length, name).toBeGreaterThan(0);
      for (const [tag, attrs] of shapes) {
        expect(["path", "rect", "circle"], name).toContain(tag);
        expect(Object.keys(attrs).length, name).toBeGreaterThan(0);
      }
    }
  });
});

async function filesBelow(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries.filter((e) => e.isFile()).map((e) => path.join(e.parentPath, e.name));
}

// Fails if Retrofit's own code, pages or agent configuration adds an emoji. Vendored files are not Retrofit's
// (runtime-icons.js replaces their emoji in the browser); tests may hold emoji as data.
it("Retrofit's own source has no emoji", async () => {
  const files = [
    ...(await filesBelow("src")),
    ...(await filesBelow("agent")),
    ...(await filesBelow("public/brand")),
    ...["public/agent-manifest.json", "public/agent-mcp.json", "public/links.json", "public/retrofit_guide.network.json", "public/retrofit_conformance.network.json", "public/site-actions.js"],
  ].filter((f) => /\.(ts|tsx|js|mjs|css|json|hocon|md|txt)$/.test(f));
  expect(files.length).toBeGreaterThan(50);
  const found: string[] = [];
  for (const file of files) {
    const lines = (await readFile(file, "utf8")).split("\n");
    lines.forEach((line, i) => {
      if (hasEmoji(line)) found.push(`${file}:${i + 1}`);
    });
  }
  expect(found).toEqual([]);
});
