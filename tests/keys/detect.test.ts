import { describe, expect, it } from "vitest";
import { detectProvider } from "@/lib/keys/detect";
import type { Provider } from "@/lib/keys/providers";

describe("detectProvider", () => {
  // Fails when a prefix in the table changes or detection stops matching on prefix.
  it.each([
    ["otk_abc123", "Otari"],
    ["AIzaSyExample", "Google AI Studio"],
    ["gsk_example", "Groq"],
    ["sk-proj-example", "OpenAI"],
    ["sk-svcacct-example", "OpenAI"],
    ["sk-ant-api03-example", "Anthropic"],
    ["sk-or-v1-0123456789abcdef", "OpenRouter"],
  ])("detects %s as %s", (key, name) => {
    expect(detectProvider(key)?.name).toBe(name);
  });

  // Fails when detection stops trimming pasted whitespace.
  it("ignores surrounding whitespace", () => {
    expect(detectProvider("  \n sk-or-v1-abc \t")?.name).toBe("OpenRouter");
  });

  // Fails when detection guesses a provider for a key it cannot place.
  it.each(["", "   ", "sk-plain-legacy", "tk-selfhosted", "SK-OR-V1-upper", "xsk-or-v1-abc"])(
    "returns null for %j",
    (key) => {
      expect(detectProvider(key)).toBeNull();
    },
  );

  // Fails when detection returns the first row in table order (runtime behavior) instead of the
  // longest matching prefix: here a shorter generic `sk-` row comes first.
  it("prefers the longest matching prefix over table order", () => {
    const row = (name: string, keyPrefixes: string[]): Provider => ({
      name,
      keyPrefixes,
      router: `https://${name.toLowerCase()}.example/v1`,
      model: "m",
      keyUrl: `https://${name.toLowerCase()}.example/keys`,
      accessNote: "",
    });
    const table = [row("Generic", ["sk-"]), row("Ant", ["sk-ant-"]), row("Router", ["sk-or-", "sk-or-v1-"])];
    expect(detectProvider("sk-or-v1-abc", table)?.name).toBe("Router");
    expect(detectProvider("sk-ant-abc", table)?.name).toBe("Ant");
    expect(detectProvider("sk-proj-abc", table)?.name).toBe("Generic");
  });
});
