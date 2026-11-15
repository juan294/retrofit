import { describe, expect, it } from "vitest";
import { type FreeConfig, loadFreeConfig } from "@/lib/config";
import { reservationFor, usageCharge } from "@/lib/inference/reservation";
import type { ChatRequest } from "@/lib/inference/schema";

// Binary-exact prices keep the expected charges free of rounding noise.
const free: FreeConfig = loadFreeConfig({ FREE_PRICE_IN_PER_M: "0.5", FREE_PRICE_OUT_PER_M: "2" }, false);
const MODEL = free.model;

const userBody = (content: string): ChatRequest => ({ model: MODEL, messages: [{ role: "user", content }] });
/** Serialized size of the body with empty content: every character in it is ASCII. */
const EMPTY = JSON.stringify(userBody("")).length;

describe("reservationFor", () => {
  // Fails if the bound counts UTF-16 code units or characters instead of UTF-8 bytes (emoji are 4 bytes, 2 units).
  it("bounds 1 KB of 4-byte characters by the formula", () => {
    const content = "😀".repeat(256);
    expect(content.length).toBe(512);
    const r = reservationFor(userBody(content), free);
    const input = EMPTY + 1024 + 16 * 1 + 512;
    expect(r.inputTokenBound).toBe(input);
    expect(r.outputTokenBound).toBe(1024);
    expect(r.microUsd).toBe(Math.ceil(input * 0.5 + 1024 * 2));
  });

  // Fails if the bound for ASCII differs from bytes + framing.
  it("bounds 1 KB of ASCII by the formula", () => {
    const r = reservationFor(userBody("a".repeat(1024)), free);
    const input = EMPTY + 1024 + 16 + 512;
    expect(r.inputTokenBound).toBe(input);
    expect(r.microUsd).toBe(Math.ceil(input * 0.5) + 2048);
  });

  // Fails if the charge is rounded down or to nearest instead of up.
  it("rounds the charge up to a whole micro-USD", () => {
    // Choose the base allowance so the input bound is odd and its half-price charge is fractional.
    const baseTokens = (EMPTY + 16) % 2 === 0 ? 511 : 512;
    const odd = loadFreeConfig({ FREE_PRICE_IN_PER_M: "0.5", FREE_PRICE_OUT_PER_M: "2", FREE_FRAMING_TOKENS_BASE: String(baseTokens) }, false);
    const r = reservationFor(userBody(""), odd);
    const input = EMPTY + 16 + baseTokens;
    expect(input % 2).toBe(1);
    expect(r.microUsd).toBe((input + 1) / 2 + 2048);
  });

  // Fails if the per-message framing allowance is missing.
  it("grows with each message by its bytes plus the per-message allowance", () => {
    const one = reservationFor(userBody("hi"), free);
    const message = { role: "user" as const, content: "hi" };
    const two = reservationFor({ model: MODEL, messages: [message, message] }, free);
    expect(two.inputTokenBound - one.inputTokenBound).toBe(JSON.stringify(message).length + 1 + 16);
  });

  // Fails if tool definitions are left out of the serialized bytes.
  it("grows with tools", () => {
    const plain = reservationFor(userBody("hi"), free);
    const withTools = reservationFor(
      { ...userBody("hi"), tools: [{ type: "function", function: { name: "lookup", description: "x".repeat(300), parameters: { type: "object" } } }] },
      free,
    );
    expect(withTools.inputTokenBound - plain.inputTokenBound).toBeGreaterThan(300);
  });

  // Fails if a configured per-request fee is not added.
  it("adds the per-request fee when configured", () => {
    const fee = loadFreeConfig({ FREE_PRICE_IN_PER_M: "0.5", FREE_PRICE_OUT_PER_M: "2", FREE_PER_REQUEST_FEE_USD: "0.0005" }, false);
    expect(reservationFor(userBody("hi"), fee).microUsd - reservationFor(userBody("hi"), free).microUsd).toBe(500);
  });
});

describe("usageCharge", () => {
  // Fails if reported usage is priced differently from the reservation, or rounded down.
  it("prices reported tokens with the same prices, fee and upward rounding", () => {
    expect(usageCharge({ promptTokens: 3, completionTokens: 10 }, free)).toBe(Math.ceil(1.5) + 20);
    const fee = loadFreeConfig({ FREE_PRICE_IN_PER_M: "0.5", FREE_PRICE_OUT_PER_M: "2", FREE_PER_REQUEST_FEE_USD: "0.0005" }, false);
    expect(usageCharge({ promptTokens: 2, completionTokens: 0 }, fee)).toBe(501);
  });
});
