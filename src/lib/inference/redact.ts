import { PROVIDERS } from "@/lib/keys/providers";

/**
 * Log redaction for the free path (phase-6.md "Logging"). Every log line the
 * proxy writes goes through `redact` or `redactText`. It removes credential
 * headers (`authorization`, `proxy-authorization`, `cookie`, `set-cookie`,
 * `x-api-key`) from log objects, and replaces in any string: a value that
 * starts with a provider key prefix from `providers.ts`, a Bearer value, the
 * `retrofit-free` placeholder, a `retrofit_session` cookie value, a signed
 * session token, and any exact configured secret (server keys, tokens).
 */

export const REDACTED = "[redacted]";

const SENSITIVE_HEADERS = new Set(["authorization", "proxy-authorization", "cookie", "set-cookie", "x-api-key"]);

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Longest first, so `sk-proj-` wins over a shorter overlapping prefix. */
const PREFIXES = [...new Set(PROVIDERS.flatMap((p) => p.keyPrefixes))].sort((a, b) => b.length - a.length);

const PATTERNS: readonly RegExp[] = [
  // A provider key: a known prefix not preceded by a letter or digit, up to the next delimiter.
  new RegExp(`(?<![A-Za-z0-9])(?:${PREFIXES.map(escape).join("|")})[^\\s"'\`,;)\\]}]*`, "g"),
  /\bBearer\s+[^\s"'`,;]+/gi,
  /retrofit_session=[^\s;"',]*/g,
  /retrofit-free/g,
  // A signed session token (`<base64url payload>.<base64url signature>`, signature 43 characters).
  /[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{40,}/g,
];

/** Redacts credentials inside one string. `secrets` are exact values to remove (server keys, tokens). */
export function redactText(text: string, secrets: readonly (string | null | undefined)[] = []): string {
  let out = text;
  for (const secret of secrets) {
    if (secret && secret.length >= 4) out = out.split(secret).join(REDACTED);
  }
  for (const pattern of PATTERNS) {
    out = out.replace(pattern, (match) => (/^bearer/i.test(match) ? `Bearer ${REDACTED}` : REDACTED));
  }
  return out;
}

/**
 * A copy of `value` safe to log: credential headers removed at any depth,
 * strings redacted, Headers objects turned into plain objects, Errors into
 * their redacted `name: message`.
 */
export function redact(value: unknown, secrets: readonly (string | null | undefined)[] = [], depth = 0): unknown {
  if (typeof value === "string") return redactText(value, secrets);
  if (value === null || typeof value !== "object") return value;
  if (depth > 8) return REDACTED;
  if (value instanceof Error) return redactText(`${value.name}: ${value.message}`, secrets);
  if (Array.isArray(value)) return value.map((v) => redact(v, secrets, depth + 1));
  const entries = value instanceof Headers ? [...value.entries()] : Object.entries(value);
  const out: Record<string, unknown> = {};
  for (const [key, v] of entries) {
    if (SENSITIVE_HEADERS.has(key.toLowerCase())) continue;
    out[redactText(key, secrets)] = redact(v, secrets, depth + 1);
  }
  return out;
}
