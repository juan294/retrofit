import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The Field Inspection design tokens (docs/plans/2026-11-26-field-inspection-ui.md, "Design specification").
const CSS_FILE = "src/app/globals.css";
const css = readFileSync(CSS_FILE, "utf8");

const TOKENS = {
  "--fi-paper": "#f0f1f0",
  "--fi-ink": "#0e0e0e",
  "--fi-accent": "#26efe9",
  "--fi-white": "#ffffff",
  "--fi-on-ink-muted": "#d7d8d6",
  "--fi-link-hover": "#2e308e",
} as const;
type Token = keyof typeof TOKENS;

/** The value a token has in the stylesheet, in lower case. */
function declared(name: string): string | undefined {
  return new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`).exec(css)?.[1]?.toLowerCase();
}

/** WCAG 2 relative luminance of a #rrggbb colour. */
function luminance(hex: string): number {
  const channel = (i: number) => {
    const s = parseInt(hex.slice(i, i + 2), 16) / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** The token's value; a missing token fails the test that needs it. */
function valueOf(name: Token): string {
  const value = declared(name);
  if (!value) throw new Error(`${name} is not declared in ${CSS_FILE}`);
  return value;
}

function contrast(a: Token, b: Token): number {
  const [la, lb] = [luminance(valueOf(a)), luminance(valueOf(b))];
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** The selector of the rule that holds the declaration at `index`. */
function selectorAt(index: number): string {
  const open = css.lastIndexOf("{", index);
  const before = Math.max(css.lastIndexOf("}", open), css.lastIndexOf("{", open - 1), css.lastIndexOf(";", open));
  return css.slice(before + 1, open).trim();
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(path);
    return /\.(tsx?|css)$/.test(e.name) ? [path] : [];
  });
}

describe("the Field Inspection tokens", () => {
  // Fails if a token is missing or gets another value: the accent is the sponsor's teal, not the old orange or blue.
  it.each(Object.entries(TOKENS))("%s is %s", (name, value) => {
    expect(declared(name)).toBe(value);
  });

  // Fails if a text and surface pair the design uses drops below WCAG AA for normal text.
  it.each([
    ["--fi-ink", "--fi-paper"],
    ["--fi-ink", "--fi-white"],
    ["--fi-ink", "--fi-accent"],
    ["--fi-accent", "--fi-ink"],
    ["--fi-paper", "--fi-ink"],
    ["--fi-on-ink-muted", "--fi-ink"],
    ["--fi-link-hover", "--fi-paper"],
    ["--fi-link-hover", "--fi-white"],
  ] as const)("%s on %s has a contrast of at least 4.5", (text, surface) => {
    expect(contrast(text, surface)).toBeGreaterThanOrEqual(4.5);
  });

  // The accent has a contrast below 1.5 on paper and on white. Fails if a rule makes it a text colour anywhere but on the ink.
  it("no rule uses the accent as a text colour outside an ink surface", () => {
    expect(contrast("--fi-accent", "--fi-paper")).toBeLessThan(3);
    expect(contrast("--fi-accent", "--fi-white")).toBeLessThan(3);
    const uses = [...css.matchAll(/(?<![-\w])color:\s*var\(--fi-accent\)/g)].map((m) => selectorAt(m.index));
    expect(uses.filter((selector) => !selector.includes(".fi-on-ink"))).toEqual([]);
  });

  // The base layer marks a disabled button with "not-allowed". A cursor on .fi-btn, in a later layer, would win over it.
  it("the button class sets no cursor of its own", () => {
    const rule = /\n {2}\.fi-btn \{([^}]*)\}/.exec(css)?.[1];
    expect(rule).toContain("min-height: 48px");
    expect(rule).not.toMatch(/cursor\s*:/);
  });

  // Fails if a component or page carries its own colour value: colours live in the stylesheet only.
  it("no component or page file holds a hex colour", () => {
    const hex = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3})(?![\w-])/;
    const files = [...sourceFiles("src/app"), ...sourceFiles("src/components")].filter((f) => f !== CSS_FILE);
    expect(files.length).toBeGreaterThan(40);
    expect(files.filter((f) => hex.test(readFileSync(f, "utf8")))).toEqual([]);
  });
});

describe("the fixed light theme", () => {
  // Fails if the page gets a second set of colours for a dark system again (decision D2).
  it("has no dark colour set and declares a light-only scheme", () => {
    expect(css).not.toMatch(/prefers-color-scheme/);
    expect(css).toMatch(/color-scheme:\s*only light\s*;/);
  });
});

describe("the runtime panel's theme", () => {
  const block = /\.runtime-surface\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
  const value = (name: string) => new RegExp(`${name}:\\s*([^;]+);`).exec(block)?.[1]?.trim();

  // The vendored runtime writes white text on --ns-primary (public/runtime/ui.js, .ns-inputbar button):
  // white on the accent is 1.44:1, so the primary must be the ink.
  it("sets the runtime's primary and its user bubble to the ink, never to the accent", () => {
    expect(value("--ns-primary")).toBe("var(--fi-ink)");
    expect(value("--ns-user-bg")).toBe("var(--fi-ink)");
    expect(block).not.toMatch(/--ns-(primary|user-bg|accent):\s*var\(--fi-accent\)/);
  });

  it("gives the runtime the page's text colour, border colour and font", () => {
    expect(value("--ns-fg")).toBe("var(--fi-ink)");
    expect(value("--ns-border")).toBe("var(--fi-ink)");
    expect(value("--ns-muted")).toBe("var(--fi-ink)");
    expect(value("--ns-font")).toBe("var(--fi-font-body)");
  });
});
