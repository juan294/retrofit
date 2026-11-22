import { crc32, deflateRawSync } from "node:zlib";

const SIZE_LIMIT = 64 * 1024 * 1024;
const CLASSIC_LIMIT = 0xffff;
const UTF8 = 0x0800;
const DOS_EPOCH = 0x0021; // 1980-01-01 in the ZIP date format.

export class BundleError extends Error {}

export interface PreparedZipData {
  readonly size: number;
  readonly checksum: number;
  readonly method: 0 | 8;
  readonly payload: Uint8Array;
}

export type ZipEntry = { path: string } & ({ bytes: Uint8Array; prepared?: PreparedZipData } | { prepared: PreparedZipData });

function checkSize(bytes: number) {
  if (bytes > SIZE_LIMIT) throw new BundleError("Bundle exceeds 64 MiB");
}

/** Prepare immutable asset bytes once for use with different archive paths. */
export function prepareZipData(bytes: Uint8Array): PreparedZipData {
  checkSize(bytes.byteLength);
  const compressed = deflateRawSync(bytes);
  const useDeflate = compressed.length < bytes.byteLength;
  return {
    size: bytes.byteLength,
    checksum: crc32(bytes),
    method: useDeflate ? 8 : 0,
    payload: useDeflate ? compressed : Buffer.from(bytes),
  };
}

function validName(path: string): Buffer {
  if (!path.isWellFormed() || path.includes("\\") || path.includes("\0") || /^[a-z]:/iu.test(path)
    || path.split("/").some(part => part === "" || part === "." || part === "..")) {
    throw new BundleError("Invalid bundle path");
  }
  if (Buffer.byteLength(path) > CLASSIC_LIMIT) throw new BundleError("Bundle path is too long");
  return Buffer.from(path, "utf8");
}

/** Create a classic (non-ZIP64) archive with a deterministic modification date. */
export function writeZip(entries: readonly ZipEntry[]): Buffer<ArrayBuffer> {
  if (entries.length >= CLASSIC_LIMIT) throw new BundleError("Too many bundle entries");

  const seen = new Set<string>();
  let inputSize = 0;
  let headerSize = 22;
  const names = entries.map(entry => {
    const name = validName(entry.path);
    if (seen.has(entry.path)) throw new BundleError("Duplicate bundle path");
    seen.add(entry.path);
    inputSize += "bytes" in entry ? entry.bytes.byteLength : entry.prepared.size;
    checkSize(inputSize);
    headerSize += 30 + 46 + 2 * name.length;
    checkSize(headerSize);
    return name;
  });

  const files: Uint8Array[] = [];
  const directory: Uint8Array[] = [];
  let fileOffset = 0;
  let directorySize = 0;
  for (const [index, entry] of entries.entries()) {
    const name = names[index]!;
    const data = "bytes" in entry ? entry.prepared ?? prepareZipData(entry.bytes) : entry.prepared;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // Extractor version 2.0 supports deflate.
    local.writeUInt16LE(UTF8, 6);
    local.writeUInt16LE(data.method, 8);
    local.writeUInt16LE(DOS_EPOCH, 12);
    local.writeUInt32LE(data.checksum, 14);
    local.writeUInt32LE(data.payload.length, 18);
    local.writeUInt32LE(data.size, 22);
    local.writeUInt16LE(name.length, 26);
    files.push(local, name, data.payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    local.copy(central, 6, 4); // Shared version, flags, data fields and name length.
    central.writeUInt32LE(fileOffset, 42);
    directory.push(central, name);

    fileOffset += local.length + name.length + data.payload.length;
    directorySize += central.length + name.length;
    checkSize(fileOffset + directorySize + 22);
  }

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directorySize, 12);
  end.writeUInt32LE(fileOffset, 16);
  return Buffer.concat([...files, ...directory, end]);
}
