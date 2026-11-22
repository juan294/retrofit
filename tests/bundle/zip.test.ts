import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bundleFiles } from "@/lib/bundle/files";
import { crawlFixtureSnapshots } from "../helpers/fixture-snapshots";
import { BundleError, prepareZipData, writeZip } from "@/lib/bundle/zip";

const empty = new Uint8Array();

function withArchive(bytes: Uint8Array, check: (file: string, dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "retrofit-zip-"));
  try {
    const file = join(dir, "bundle.zip");
    writeFileSync(file, bytes);
    const result = execFileSync("python3", ["-I", "-m", "zipfile", "-t", file], { encoding: "utf8" });
    expect(result.trim()).toBe("Done testing");
    check(file, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("install ZIP", () => {
  it("extracts exact bytes with UTF-8 names, fixed dates, deflate and stored entries", () => {
    const entries = [
      { path: "bundle/site/café.txt", bytes: Buffer.from("Répéter. ".repeat(100)) },
      { path: "bundle/site/byte.bin", bytes: Buffer.from([255]) },
      { path: "bundle/site/empty", bytes: Buffer.alloc(0) },
    ];
    const archive = writeZip(entries);
    expect(writeZip(entries)).toEqual(archive);
    withArchive(archive, (file, dir) => {
      execFileSync("python3", ["-I", "-m", "zipfile", "-e", file, dir]);
      for (const entry of entries) expect(readFileSync(join(dir, entry.path))).toEqual(entry.bytes);
      const metadata = execFileSync("python3", ["-I", "-c",
        "import sys,zipfile,json; print(json.dumps([(i.compress_type,i.flag_bits,i.date_time) for i in zipfile.ZipFile(sys.argv[1]).infolist()]))",
        file], { encoding: "utf8" });
      expect(JSON.parse(metadata)).toEqual([8, 0, 0].map(method => [method, 0x800, [1980, 1, 1, 0, 0, 0]]));
    });
  });

  it("validates every fixture archive and keeps every member beneath its single install folder", async () => {
    const snapshots = await crawlFixtureSnapshots();
    for (const snapshot of snapshots.values()) {
      const { topFolder, entries } = await bundleFiles(snapshot);
      withArchive(writeZip(entries), file => {
        const listing = execFileSync("python3", ["-I", "-c",
          "import json,sys,zipfile; print(json.dumps(zipfile.ZipFile(sys.argv[1]).namelist()))",
          file], { encoding: "utf8" });
        const names: string[] = JSON.parse(listing);
        expect(names.length).toBeGreaterThan(0);
        for (const name of names) {
          expect(name.startsWith(topFolder + "/")).toBe(true);
          expect(name.split("/")).not.toContain("..");
          expect(name).not.toMatch(/^(?:[a-z]:|\/)|\\/iu);
        }
      });
    }
  }, 60_000);

  it("reuses prepared data under different bundle paths", () => {
    const bytes = Buffer.from("cached asset".repeat(100));
    const prepared = prepareZipData(bytes);
    for (const path of ["a/site/runtime/file.js", "b/site/runtime/file.js"]) {
      expect(writeZip([{ path, prepared }])).toEqual(writeZip([{ path, bytes }]));
    }
  });

  it.each(["", "/site/a", "C:/site/a", "a\\b", "../site", "site/../a", "site/./a", "a//b", "a/", "a\0b"])(
    "rejects an unsafe or ambiguous path %j", path => {
      expect(() => writeZip([{ path, bytes: empty }])).toThrow(BundleError);
    },
  );

  it("refuses duplicate names, oversized encoded names and ZIP64 entry counts", () => {
    const item = { path: "a", bytes: empty };
    expect(() => writeZip([item, item])).toThrow(BundleError);
    expect(() => writeZip([{ ...item, path: "é".repeat(32768) }])).toThrow(BundleError);
    expect(() => writeZip(Array(65536).fill(item))).toThrow(BundleError);
  });

  it("refuses more than 64 MiB of content even if it compresses well", () => {
    const prepared = prepareZipData(Buffer.alloc(1024 * 1024));
    expect(() => writeZip(Array.from({ length: 65 }, (_, i) => ({ path: String(i), prepared })))).toThrow(BundleError);
  });
});
