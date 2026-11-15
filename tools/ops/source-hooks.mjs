// Lets a plain `node` command import the application's TypeScript modules in src/ (ops tools).
//
// Next.js and Vitest resolve the `@/` alias and extensionless imports and compile TypeScript;
// plain Node does neither. These in-thread module hooks (node:module registerHooks) map `@/x` to
// src/x, add the `.ts` extension to an extensionless relative import, and compile each `.ts`
// file with Node's own TypeScript transform (module.stripTypeScriptTypes, "transform" mode, which
// also handles parameter properties). Nothing is bundled or written to disk. Only call
// registerSourceHooks from an executable entry point, never from a module that tests import.
import fs from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";

const SRC = new URL("../../src/", import.meta.url);

/** The `.ts` file (or directory index) for an extensionless file URL, or null. */
function typescriptFor(url) {
  if (!url.startsWith("file:") || /\.[cm]?[jt]sx?$|\.json$/.test(url)) return null;
  for (const candidate of [`${url}.ts`, `${url}/index.ts`]) {
    if (fs.existsSync(fileURLToPath(candidate))) return candidate;
  }
  return null;
}

let registered = false;

/**
 * Drops only Node's ExperimentalWarning for stripTypeScriptTypes, which the load hook calls for
 * every file; every other warning is emitted as before.
 */
function silenceStripWarning() {
  const emit = process.emitWarning;
  process.emitWarning = function emitWarning(warning, ...rest) {
    const type = typeof rest[0] === "string" ? rest[0] : (rest[0]?.type ?? warning?.name);
    const message = typeof warning === "string" ? warning : warning?.message;
    if (type === "ExperimentalWarning" && /stripTypeScriptTypes/.test(String(message))) return;
    return emit.call(this, warning, ...rest);
  };
}

export function registerSourceHooks() {
  if (registered) return;
  registered = true;
  silenceStripWarning();
  registerHooks({
    resolve(specifier, context, nextResolve) {
      // Only application modules (the alias, or a relative import from a file under src/) are
      // rewritten; dependencies in node_modules, including their CommonJS requires, resolve as usual.
      let target = null;
      if (specifier.startsWith("@/")) target = new URL(specifier.slice(2), SRC).href;
      else if (/^\.\.?\//.test(specifier) && context.parentURL?.startsWith(SRC.href)) target = new URL(specifier, context.parentURL).href;
      if (target === null) return nextResolve(specifier, context);
      const ts = typescriptFor(target);
      if (ts) return { url: ts, format: "module", shortCircuit: true };
      return nextResolve(target, context);
    },
    load(url, context, nextLoad) {
      if (!url.startsWith("file:") || !url.endsWith(".ts")) return nextLoad(url, context);
      const source = fs.readFileSync(fileURLToPath(url), "utf8");
      return { format: "module", source: stripTypeScriptTypes(source, { mode: "transform", sourceUrl: url }), shortCircuit: true };
    },
  });
}

/** The file URL of a module under src/, for a dynamic import after registerSourceHooks. */
export const sourceUrl = (relative) => new URL(relative, SRC).href;
