import { describe, expect, it } from "vitest";
import { newToken, sha256Hex, SHA256_HEX_PATTERN, TOKEN_PATTERN } from "@/lib/security/tokens";

describe("tokens", () => {
  // Fails if a token is not 128 random bits in lower-case hex, or two tokens repeat.
  it("newToken is 32 lower-case hex characters and differs each call", () => {
    const a = newToken();
    expect(a).toMatch(TOKEN_PATTERN);
    expect(newToken()).not.toBe(a);
  });

  // Fails if the stored hash is not SHA-256 hex of the token (a stored hash would never match its link or cookie).
  it("sha256Hex is SHA-256 in hex", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256Hex("abc")).toMatch(SHA256_HEX_PATTERN);
  });
});
