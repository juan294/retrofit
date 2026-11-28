// Renders Retrofit's browser icons from the one source mark, src/app/icon.svg (an ink square with a teal R on a
// 32-unit grid; even coordinates keep the 16 px favicon sharp). Run after a change to the mark and commit the output:
//   node tools/brand/build-icons.mjs
// Next.js serves src/app/icon.svg, favicon.ico and apple-icon.png by its file conventions; src/app/manifest.ts
// names the PNGs in public/icons/. Chromium from @playwright/test does the rendering.
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";
import { chromium } from "@playwright/test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const mark = readFileSync(join(root, "src/app/icon.svg"), "utf8");

// A maskable icon keeps its content inside the central circle of radius 0.4 of the size (W3C manifest spec).
// The R reaches that circle exactly at its top-left corner, so the maskable copy draws it at 80 %.
const maskable = mark.replace(/(<path[^>]*\/>)/, '<g transform="translate(16 16) scale(0.8) translate(-16 -16)">$1</g>');
if (maskable === mark) throw new Error("src/app/icon.svg has no <path> to scale for the maskable icon");

const browser = await chromium.launch();
const page = await browser.newPage();

// The page draws the SVG on a canvas and returns its RGBA pixels; Node writes them as an RGBA PNG (colour type 6).
// The ICO decoder in the Next.js build accepts only RGBA images, and a screenshot drops the alpha channel.
async function png(svg, size) {
  const src = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
  const rgba = await page.evaluate(
    async ({ src, size }) => {
      const img = document.createElement("img");
      img.width = img.height = size;
      img.src = src;
      await img.decode();
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = size;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, size, size);
      return Array.from(ctx.getImageData(0, 0, size, size).data);
    },
    { src, size },
  );
  const rows = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) Buffer.from(rgba.slice(y * size * 4, (y + 1) * size * 4)).copy(rows, y * (size * 4 + 1) + 1);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(rows, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

// An ICO file whose images are PNG data (read by every current browser and by Windows since Vista).
function ico(images) {
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, data }, i) => {
    const entry = 6 + 16 * i;
    header.writeUInt8(size >= 256 ? 0 : size, entry);
    header.writeUInt8(size >= 256 ? 0 : size, entry + 1);
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(data.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...images.map((image) => image.data)]);
}

// One page renders one image at a time.
const favicon = [];
for (const size of [16, 32, 48]) favicon.push({ size, data: await png(mark, size) });
const out = {
  "src/app/favicon.ico": ico(favicon),
  "src/app/apple-icon.png": await png(mark, 180),
  "public/icons/icon-192.png": await png(mark, 192),
  "public/icons/icon-512.png": await png(mark, 512),
  "public/icons/maskable-512.png": await png(maskable, 512),
};
await browser.close();

for (const [path, data] of Object.entries(out)) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), data);
  console.log(`${path} ${data.length} bytes`);
}
