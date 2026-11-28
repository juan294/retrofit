/**
 * Retrofit's browser icons (tools/brand/build-icons.mjs renders them from src/app/icon.svg): every file the
 * manifest and the Next.js icon conventions name exists and has the size it claims.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import manifest from "@/app/manifest";
import { BRAND_COLOURS } from "@/lib/site/brand";

const root = join(__dirname, "..", "..");
const PNG_SIGNATURE = "89504e470d0a1a0a";

function pngSize(data: Buffer): { width: number; height: number } {
  expect(data.subarray(0, 8).toString("hex")).toBe(PNG_SIGNATURE);
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}

describe("browser icons", () => {
  // Fails if a manifest icon is missing, is not a PNG, or its pixels differ from its declared size.
  it("each manifest icon is a PNG of its declared size in public/", () => {
    const icons = manifest().icons ?? [];
    expect(icons.map((i) => i.src)).toEqual(["/icons/icon-192.png", "/icons/icon-512.png", "/icons/maskable-512.png"]);
    for (const icon of icons) {
      const [w, h] = (icon.sizes ?? "").split("x").map(Number);
      expect(icon.type).toBe("image/png");
      expect(pngSize(readFileSync(join(root, "public", icon.src)))).toEqual({ width: w, height: h });
    }
    expect(icons.find((i) => i.src.includes("maskable"))?.purpose).toBe("maskable");
  });

  // Fails if the colour the browser reads first drifts from the stylesheet's paper token.
  it("the brand paper colour equals the --fi-paper token", () => {
    const css = readFileSync(join(root, "src/app/globals.css"), "utf8");
    expect(/--fi-paper:\s*(#[0-9a-f]{6});/.exec(css)?.[1]).toBe(BRAND_COLOURS.paper);
  });

  // Fails if the manifest loses its name, start page or the Field Inspection paper colour.
  it("the manifest names Retrofit and uses the paper colour", () => {
    const m = manifest();
    expect(m).toMatchObject({ name: "Retrofit", short_name: "Retrofit", start_url: "/", background_color: "#f0f1f0", theme_color: "#f0f1f0" });
  });

  // Fails if the favicon is not an ICO holding 16, 32 and 48 px PNG images.
  it("favicon.ico holds 16, 32 and 48 px images", () => {
    const ico = readFileSync(join(root, "src/app/favicon.ico"));
    expect([ico.readUInt16LE(0), ico.readUInt16LE(2)]).toEqual([0, 1]);
    const sizes = Array.from({ length: ico.readUInt16LE(4) }, (_, i) => {
      const entry = 6 + 16 * i;
      const data = ico.subarray(ico.readUInt32LE(entry + 12), ico.readUInt32LE(entry + 12) + ico.readUInt32LE(entry + 8));
      const size = pngSize(data);
      expect(size).toEqual({ width: ico.readUInt8(entry), height: ico.readUInt8(entry + 1) });
      return size.width;
    });
    expect(sizes).toEqual([16, 32, 48]);
  });

  // Fails if the Apple touch icon is not the 180 px size iOS asks for, or the source mark loses its colours.
  it("the Apple touch icon is 180 px and the mark uses ink and the accent", () => {
    expect(pngSize(readFileSync(join(root, "src/app/apple-icon.png")))).toEqual({ width: 180, height: 180 });
    const svg = readFileSync(join(root, "src/app/icon.svg"), "utf8");
    expect(svg).toContain('fill="#0e0e0e"');
    expect(svg).toContain('fill="#26efe9"');
  });
});
