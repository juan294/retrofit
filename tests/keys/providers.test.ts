import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PROVIDERS, providerForRouter, routerOrigins } from "@/lib/keys/providers";

const UI_JS = path.resolve(__dirname, "../../public/runtime/ui.js");
const OPENROUTER_JS = path.resolve(__dirname, "../../public/runtime/openrouter-connect.js");

/** The string constants of the vendored OpenRouterConnect class, which the provider literal refers to. */
function openRouterConstants(): Record<string, string> {
  const source = readFileSync(OPENROUTER_JS, "utf8");
  return Object.fromEntries([...source.matchAll(/^\s*static ([A-Z_]+) = "([^"]*)";/gm)].map((m) => [m[1]!, m[2]!]));
}

type RuntimeRow = {
  name: string;
  keyUrl: string;
  router: string;
  model: string;
  keyPrefixes: string[];
  accessNote: string;
  button?: boolean;
};

/** Reads `API_KEY_PROVIDERS` from the vendored source text (no runtime import, no DOM). */
function runtimeRows(): RuntimeRow[] {
  const source = readFileSync(UI_JS, "utf8");
  const start = source.indexOf("export const API_KEY_PROVIDERS = [");
  expect(start, "ui.js no longer exports API_KEY_PROVIDERS").toBeGreaterThan(-1);
  const open = source.indexOf("[", start);
  const close = source.indexOf("\n];", open);
  // The vendored literal holds only strings, booleans, arrays, comments and OpenRouterConnect constants.
  return new Function("OpenRouterConnect", `return ${source.slice(open, close + 2)}`)(openRouterConstants()) as RuntimeRow[];
}

describe("provider rows", () => {
  // Fails when a row in providers.ts drifts from the vendored runtime (name, prefixes, router,
  // model, key page, note or button), or when a runtime row is dropped, reordered or added to.
  it("are exactly the vendored runtime rows, in order and unchanged", () => {
    const rows = runtimeRows();
    expect(rows.length).toBe(7);
    const ours = PROVIDERS.map(({ name, keyUrl, router, model, keyPrefixes, accessNote, button }) => ({
      name,
      keyUrl,
      router,
      model,
      keyPrefixes: [...keyPrefixes],
      accessNote,
      ...(button === undefined ? {} : { button }),
    }));
    expect(ours).toEqual(rows);
  });

  // Fails when the EU Otari row loses its gateway, its prefix or its hidden button (OT-2).
  it("route EU Otari keys to the EU gateway without a second Otari button", () => {
    const eu = PROVIDERS.find((p) => p.name === "Otari EU")!;
    expect(eu.router).toBe("https://eu.api.otari.ai/api/v1");
    expect(eu.keyPrefixes).toEqual(["otk_v1_eu_"]);
    expect(eu.button).toBe(false);
    expect(PROVIDERS.filter((p) => p.button !== false).map((p) => p.name)).not.toContain("Otari EU");
  });

  // Fails when routerOrigins returns paths, duplicates or misses a provider (connect-src input).
  it("list each router origin once", () => {
    expect(routerOrigins()).toEqual([
      "https://api.otari.ai",
      "https://eu.api.otari.ai",
      "https://generativelanguage.googleapis.com",
      "https://api.groq.com",
      "https://openrouter.ai",
      "https://api.openai.com",
      "https://api.anthropic.com",
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
