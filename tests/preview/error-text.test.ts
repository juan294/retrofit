import { describe, expect, it } from "vitest";
import { friendlyRuntimeError } from "@/lib/preview/error-text";

describe("friendlyRuntimeError", () => {
  // Fails if a router's JSON error reaches the visitor as raw JSON instead of its message.
  // The warning emoji is gone too: the preview shows Retrofit's warning icon in front of the message.
  it("turns the runtime's JSON error bubble into the error's message, without the emoji", () => {
    const raw = `⚠️ LLM HTTP 429: {"error":{"message":"Retrofit's free AI is used up for today. Use your own AI key to continue.","type":"rate_limit_error","code":"public_pool"}}`;
    expect(friendlyRuntimeError(raw)).toBe("Retrofit's free AI is used up for today. Use your own AI key to continue.");
  });

  // Fails if other text is rewritten: non-error bubbles, non-JSON bodies (kept so hostile markup stays visible and inert),
  // JSON without a string message, or a message that the runtime cut at 300 characters.
  it("leaves everything else unchanged (returns null)", () => {
    expect(friendlyRuntimeError("Our opening hours are 9 to 5.")).toBeNull();
    expect(friendlyRuntimeError("⚠️ LLM HTTP 500: <html><img src=x></html>")).toBeNull();
    expect(friendlyRuntimeError(`⚠️ LLM HTTP 401: {"error":"invalid key"}`)).toBeNull();
    expect(friendlyRuntimeError(`⚠️ LLM HTTP 429: {"error":{"message":"cut off`)).toBeNull();
  });
});
