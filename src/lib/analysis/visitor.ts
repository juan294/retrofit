import { timingSafeEqual } from "node:crypto";
import type { Config } from "@/lib/config";
import { buildCookie, cookieValue } from "@/lib/security/cookies";
import { newToken, sha256Hex, TOKEN_PATTERN } from "@/lib/security/tokens";

/**
 * The visitor cookie authorizes every result, status and preview route. It is
 * 128 bits of randomness; the Store keeps only its SHA-256 (`ownerHash`).
 */
export const VISITOR_COOKIE = "retrofit_visitor";
export const VISITOR_MAX_AGE_S = 30 * 24 * 3600;
/** Constant-time comparison of two strings (hashes, tokens). */
export function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}

/** True when `Authorization` is exactly `Bearer <secret>`, compared in constant time. Always false without a secret. */
export function hasBearer(request: Request, secret: string | null): boolean {
  const auth = request.headers.get("authorization") ?? "";
  return !!secret && auth.startsWith("Bearer ") && sameHash(auth.slice(7), secret);
}

/** The visitor token from the Cookie header, or null when absent or malformed. */
export function readVisitorToken(request: Request): string | null {
  const value = cookieValue(request.headers.get("cookie"), VISITOR_COOKIE);
  return value !== null && TOKEN_PATTERN.test(value) ? value : null;
}

/** True when the request reached Retrofit over HTTPS (the request URL or the public origin). */
export function isSecureRequest(request: Request, config: Pick<Config, "publicOrigin">): boolean {
  return new URL(request.url).protocol === "https:" || config.publicOrigin.startsWith("https:");
}

export function visitorSetCookie(token: string, secure: boolean): string {
  return buildCookie(VISITOR_COOKIE, token, { path: "/", maxAge: VISITOR_MAX_AGE_S, secure });
}

export interface Visitor {
  readonly hash: string;
  /** Set-Cookie value when the request had no valid visitor cookie, else null. */
  readonly setCookie: string | null;
}

/** The request's visitor, creating a new one (with its Set-Cookie) when the cookie is absent. */
export function resolveVisitor(request: Request, config: Pick<Config, "publicOrigin">): Visitor {
  const existing = readVisitorToken(request);
  if (existing) return { hash: sha256Hex(existing), setCookie: null };
  const token = newToken();
  return { hash: sha256Hex(token), setCookie: visitorSetCookie(token, isSecureRequest(request, config)) };
}
