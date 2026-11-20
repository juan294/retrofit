import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PROVIDERS, providerForRouter, routerOrigins } from "@/lib/keys/providers";

const UI_JS = path.resolve(__dirname, "../../public/runtime/ui.js");

type RuntimeRow = {
  name: string;
  keyUrl: string;
  router: string;
  model: string;
  keyPrefixes: string[];
  accessNote: string;
};

/** Reads `API_KEY_PROVIDERS` from the vendored source text (no runtime import, no DOM). */
function runtimeRows(): RuntimeRow[] {
  const source = readFileSync(UI_JS, "utf8");
  const start = source.indexOf("export const API_KEY_PROVIDERS = [");
  expect(start, "ui.js no longer exports API_KEY_PROVIDERS").toBeGreaterThan(-1);
  const open = source.indexOf("[", start);
  const close = source.indexOf("\n];", open);
  // The vendored literal holds only strings, arrays and comments.
  return new Function(`return ${source.slice(open, close + 2)}`)() as RuntimeRow[];
}

describe("provider rows", () => {
  // Fails when a row in providers.ts drifts from the vendored runtime (name, prefixes, router,
  // model, key page or note), or when a runtime row is dropped or reordered.
  it("start with the vendored runtime rows, in order and unchanged", () => {
    const rows = runtimeRows();
    expect(rows.length).toBe(5);
    const ours = PROVIDERS.slice(0, rows.length).map(({ name, keyUrl, router, model, keyPrefixes, accessNote }) => ({
      name,
      keyUrl,
      router,
      model,
      keyPrefixes: [...keyPrefixes],
      accessNote,
    }));
    expect(ours).toEqual(rows);
  });

  // Fails when the OpenRouter row is removed or its prefix, router or key page changes.
  it("add exactly one OpenRouter row after them", () => {
    expect(PROVIDERS).toHaveLength(6);
    const row = PROVIDERS[5]!;
    expect(row.name).toBe("OpenRouter");
    expect(row.keyPrefixes).toEqual(["sk-or-v1-"]);
    expect(row.router).toBe("https://openrouter.ai/api/v1");
    expect(row.keyUrl).toBe("https://openrouter.ai/keys");
    expect(row.model).toMatch(/^[a-z0-9-]+\/[a-z0-9.:-]+$/);
  });

  // Fails when routerOrigins returns paths, duplicates or misses a provider (connect-src input).
  it("list each router origin once", () => {
    expect(routerOrigins()).toEqual([
      "https://api.otari.ai",
      "https://generativelanguage.googleapis.com",
      "https://api.groq.com",
      "https://api.openai.com",
      "https://api.anthropic.com",
      "https://openrouter.ai",
    ]);
  });

  // Fails when providerForRouter accepts a router that is not in the table (Advanced is a closed list).
  it("resolve a router back to its provider, and nothing else", () => {
    expect(providerForRouter("https://api.groq.com/openai/v1/")?.name).toBe("Groq");
    expect(providerForRouter("https://api.groq.com/other")).toBeNull();
    expect(providerForRouter("https://evil.example/v1")).toBeNull();
    expect(providerForRouter("not a url")).toBeNull();
  });
});
