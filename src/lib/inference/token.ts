import { createHmac } from "node:crypto";
import { sameHash } from "@/lib/analysis/visitor";

/**
 * The free-path session token (phase-6.md "Sessions"): `<payload>.<sig>`, where
 * the payload is base64url JSON claims and the signature is HMAC-SHA-256 with
 * SESSION_SECRET over a domain-separated string, so it never matches another
 * HMAC that the same secret produces (dispatch token, client salt).
 */

export type SessionPool = "public" | "judge";

export interface SessionClaims {
  /** 128-bit random session id, 32 hex characters. */
  readonly sid: string;
  /** Issued and expiry times, ms since the epoch. */
  readonly iat: number;
  readonly exp: number;
  /** Hashed client id at creation (`clientIdFor`), never the raw IP. */
  readonly client: string;
  readonly pool: SessionPool;
}

export const SESSION_TTL_MS = 2 * 3600 * 1000;
/** A judge enters the code once and keeps access through judging, over a break of weeks: 60 days from the last visit. */
export const JUDGE_SESSION_TTL_MS = 60 * 86_400 * 1000;
export const sessionTtlMs = (pool: SessionPool): number => (pool === "judge" ? JUDGE_SESSION_TTL_MS : SESSION_TTL_MS);

/** Ties a judge session to the judge code that opened it, without the code: a replaced JUDGE_CODE ends the old code's sessions. */
export const judgeCodeTag = (code: string, secret: string): string => createHmac("sha256", secret).update(`retrofit-judge-code-v1.${code}`).digest("hex");

const PART = /^[A-Za-z0-9_-]+$/;
const SID = /^[0-9a-f]{32}$/;

function signature(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(`retrofit-session-v1.${payload}`).digest("base64url");
}

export function signSession(claims: SessionClaims, secret: string): string {
  const { sid, iat, exp, client, pool } = claims;
  const payload = Buffer.from(JSON.stringify({ sid, iat, exp, client, pool }), "utf8").toString("base64url");
  return `${payload}.${signature(payload, secret)}`;
}

function asClaims(value: unknown): SessionClaims | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.sid !== "string" || !SID.test(v.sid)) return null;
  if (typeof v.iat !== "number" || !Number.isFinite(v.iat)) return null;
  if (typeof v.exp !== "number" || !Number.isFinite(v.exp)) return null;
  if (typeof v.client !== "string" || v.client === "") return null;
  if (v.pool !== "public" && v.pool !== "judge") return null;
  return { sid: v.sid, iat: v.iat, exp: v.exp, client: v.client, pool: v.pool };
}

/** The claims of a valid, unexpired token; null when tampered, expired, signed with another secret or malformed. */
export function verifySession(token: string, secret: string, nowMs: number): SessionClaims | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payload, sig] = parts as [string, string];
  if (!PART.test(payload) || !PART.test(sig)) return null;
  if (!sameHash(sig, signature(payload, secret))) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  const claims = asClaims(parsed);
  if (!claims || nowMs >= claims.exp) return null;
  return claims;
}
