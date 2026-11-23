// The responses of agent files: the private preview's and a published site's.

import { readFile } from "node:fs/promises";
import path from "node:path";

export const JSON_TYPE = "application/json";
const TYPES: Record<string, string> = { ".js": "text/javascript; charset=utf-8", ".html": "text/html; charset=utf-8", ".json": JSON_TYPE };

/** An agent file: never cached, sniffed or indexed. */
export function respond(status: number, body: BodyInit, contentType: string): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": contentType,
      "cache-control": "private, no-store",
      "x-robots-tag": "noindex",
      "x-content-type-options": "nosniff",
    },
  });
}

export const jsonResponse = (status: number, body: unknown) => respond(status, JSON.stringify(body), JSON_TYPE);

/** A file under `dir` with its type, or null (outside it, of another type, or missing). The caller admits only known names. */
export async function assetResponse(dir: string, relative: string): Promise<Response | null> {
  const root = path.resolve(dir);
  const file = path.resolve(root, relative);
  // Defense in depth: the allowlist already admits no separator or dot segment.
  if (!file.startsWith(root + path.sep)) return null;
  const type = TYPES[path.extname(file)];
  if (!type) return null;
  try {
    return respond(200, await readFile(file, "utf8"), type);
  } catch {
    return null;
  }
}
