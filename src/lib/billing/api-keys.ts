import { newToken, sha256Hex } from "@/lib/security/tokens";
import type { NewApiKey } from "@/lib/accounts/data";

/**
 * API keys for GET /api/score: `rk_retrofit_` and 128 random bits in hex. The `retrofit_` part tells
 * them apart from Stripe's restricted keys, which also start with `rk_`. A key is shown once; only its
 * SHA-256 and its last four characters are stored. Never logged.
 */
const API_KEY = /^rk_retrofit_[0-9a-f]{32}$/;

export function newApiKey(): { readonly key: string; readonly stored: NewApiKey } {
  const key = `rk_retrofit_${newToken()}`;
  return { key, stored: { keyHash: sha256Hex(key), hint: key.slice(-4) } };
}

/**
 * The key of a request: `none` without an Authorization header, or with one that does not start like a
 * key (another scheme, another service's bearer token: ignored, as before keys existed); `malformed` for a
 * value that starts like one (`rk_`) but is no Retrofit key; else the key's hash.
 */
export function readApiKey(request: Request): { readonly kind: "none" | "malformed" } | { readonly kind: "key"; readonly hash: string } {
  const header = request.headers.get("authorization")?.trim();
  if (!header) return { kind: "none" };
  const key = /^bearer\s+(.*)$/i.exec(header)?.[1] ?? null;
  if (key === null) return { kind: header.startsWith("rk_") ? "malformed" : "none" };
  if (!key.startsWith("rk_")) return { kind: "none" };
  return API_KEY.test(key) ? { kind: "key", hash: sha256Hex(key) } : { kind: "malformed" };
}
