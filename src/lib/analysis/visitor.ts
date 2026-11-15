import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Config } from "@/lib/config";

/**
 * The visitor cookie authorizes every result, status and preview route. It is
 * 128 bits of randomness; the Store keeps only its SHA-256 (`ownerHash`).
 */
export const VISITOR_COOKIE = "retrofit_visitor";
export const VISITOR_MAX_AGE_S = 30 * 24 * 3600;
const TOKEN = /^[0-9a-f]{32}$/;

export function newVisitorToken(): string {
  return randomBytes(16).toString("hex");
}

export function hashVisitor(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Constant-time comparison of two strings (hashes, tokens). */
export function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}

/** The visitor token from the Cookie header, or null when absent or malformed. */
export function readVisitorToken(request: Request): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1 || part.slice(0, eq).trim() !== VISITOR_COOKIE) continue;
    const value = part.slice(eq + 1).trim();
    return TOKEN.test(value) ? value : null;
  }
  return null;
}

/** True when the request reached Retrofit over HTTPS (the request URL or the public origin). */
export function isSecureRequest(request: Request, config: Pick<Config, "publicOrigin">): boolean {
  return new URL(request.url).protocol === "https:" || config.publicOrigin.startsWith("https:");
}

export function visitorSetCookie(token: string, secure: boolean): string {
  const attrs = [`${VISITOR_COOKIE}=${token}`, "HttpOnly", "SameSite=Lax", "Path=/", `Max-Age=${VISITOR_MAX_AGE_S}`];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

export interface Visitor {
  readonly hash: string;
  /** Set-Cookie value when the request had no valid visitor cookie, else null. */
  readonly setCookie: string | null;
}

/** The request's visitor, creating a new one (with its Set-Cookie) when the cookie is absent. */
export function resolveVisitor(request: Request, config: Pick<Config, "publicOrigin">): Visitor {
  const existing = readVisitorToken(request);
  if (existing) return { hash: hashVisitor(existing), setCookie: null };
  const token = newVisitorToken();
  return { hash: hashVisitor(token), setCookie: visitorSetCookie(token, isSecureRequest(request, config)) };
}
