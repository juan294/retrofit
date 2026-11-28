import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { JUDGE_SESSION_TTL_MS, sessionTtlMs, SESSION_TTL_MS, signSession, verifySession, type SessionClaims } from "@/lib/inference/token";

const SECRET = "k".repeat(32);
const NOW = Date.parse("2026-11-15T10:00:00.000Z");
const claims: SessionClaims = { sid: "a".repeat(32), iat: NOW, exp: NOW + SESSION_TTL_MS, client: "c".repeat(64), pool: "public" };

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");

describe("session token", () => {
  // Fails if signing or verifying drops a claim, or the expiry is not two hours.
  it("round-trips valid claims and expires after two hours", () => {
    expect(SESSION_TTL_MS).toBe(2 * 3600 * 1000);
    const token = signSession(claims, SECRET);
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(verifySession(token, SECRET, NOW + 1000)).toEqual(claims);
    expect(verifySession(signSession({ ...claims, pool: "judge" }, SECRET), SECRET, NOW)?.pool).toBe("judge");
  });

  // Fails if a public session gets the judge lifetime, or the judge lifetime does not cover the judging period.
  it("lasts two hours in the public pool and 60 days in the judge pool", () => {
    expect([sessionTtlMs("public"), sessionTtlMs("judge")]).toEqual([SESSION_TTL_MS, JUDGE_SESSION_TTL_MS]);
    expect(JUDGE_SESSION_TTL_MS).toBe(60 * 86_400_000);
  });

  // Fails if the payload is trusted without checking the signature against it.
  it("refuses a tampered payload", () => {
    const [, sig] = signSession(claims, SECRET).split(".");
    const forged = b64(JSON.stringify({ ...claims, pool: "judge" }));
    expect(verifySession(`${forged}.${sig}`, SECRET, NOW)).toBeNull();
  });

  // Fails if the signature is not compared, or only a prefix of it is compared.
  it("refuses a tampered signature", () => {
    const token = signSession(claims, SECRET);
    const [payload, sig] = token.split(".") as [string, string];
    const flipped = (sig.slice(0, -1) + (sig.endsWith("A") ? "B" : "A"));
    expect(verifySession(`${payload}.${flipped}`, SECRET, NOW)).toBeNull();
    expect(verifySession(`${payload}.${sig.slice(0, 10)}`, SECRET, NOW)).toBeNull();
    expect(verifySession(`${payload}.`, SECRET, NOW)).toBeNull();
  });

  // Fails if `exp` is ignored or compared with the wrong sign.
  it("refuses an expired token", () => {
    const token = signSession(claims, SECRET);
    expect(verifySession(token, SECRET, claims.exp - 1)).not.toBeNull();
    expect(verifySession(token, SECRET, claims.exp)).toBeNull();
    expect(verifySession(token, SECRET, claims.exp + 60_000)).toBeNull();
  });

  // Fails if the secret is not part of the signature.
  it("refuses a token signed with another secret", () => {
    expect(verifySession(signSession(claims, "x".repeat(32)), SECRET, NOW)).toBeNull();
  });

  // Fails if a token that is not two base64url parts, or whose payload is not valid claims, is accepted or throws.
  it("refuses malformed tokens without throwing", () => {
    const signed = (payload: string) => `${payload}.${createHmac("sha256", SECRET).update(`retrofit-session-v1.${payload}`).digest("base64url")}`;
    for (const bad of [
      "",
      "abc",
      "a.b.c",
      "not base64!.sig",
      signed(b64("not json")),
      signed(b64(JSON.stringify({ ...claims, pool: "admin" }))),
      signed(b64(JSON.stringify({ ...claims, sid: 7 }))),
      signed(b64(JSON.stringify({ ...claims, exp: "later" }))),
      signed(b64(JSON.stringify(null))),
    ]) {
      expect(verifySession(bad, SECRET, NOW)).toBeNull();
    }
    // The control: a correctly signed valid payload with the same construction is accepted.
    expect(verifySession(signed(b64(JSON.stringify(claims))), SECRET, NOW)).toEqual(claims);
  });
});
