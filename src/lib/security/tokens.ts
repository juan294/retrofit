import { createHash, randomBytes } from "node:crypto";

/**
 * Random tokens and their hashes: the visitor cookie, unsubscribe links and
 * later one-time tokens. A token is 128 random bits in lower-case hex; only its
 * SHA-256 (hex) is ever stored.
 */

export const TOKEN_PATTERN = /^[0-9a-f]{32}$/;
export const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

export function newToken(): string {
  return randomBytes(16).toString("hex");
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
