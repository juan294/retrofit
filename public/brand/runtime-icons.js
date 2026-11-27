// Retrofit's icons for the vendored runtime (public/runtime/ui.js, never edited). The runtime writes emoji as
// icons and message prefixes; this module puts a Field Inspection line icon in place of each one and removes
// any other emoji from the runtime's text. The hosted preview and the installed assistant both load this file.
// Plain JavaScript without imports: the install bundle copies it unchanged to assistant/runtime-icons.js.

/**
 * Each icon: SVG children on a 24 by 24 grid, drawn with a 2-unit square-ended line in the text colour.
 * @type {Readonly<Record<"concierge" | "partner" | "service" | "link" | "tool" | "warning" | "back" | "mark", ReadonlyArray<readonly [string, Readonly<Record<string, string>>]>>>}
 */
export const ICONS = {
  // The site's own agent ("your concierge"): a compass needle in a square frame.
  concierge: [
    ["rect", { x: "3", y: "3", width: "18", height: "18" }],
    ["path", { d: "M12 6l4 6-4 6-4-6z", "stroke-linejoin": "bevel" }],
    ["path", { d: "M12 6l4 6H8z", fill: "currentColor", stroke: "none" }],
  ],
  // A partner network: a flat-roofed block with four windows and a door on a ground line.
  partner: [
    ["path", { d: "M2 21h20M5 21V3h14v18M10 21v-4h4v4" }],
    ["path", { d: "M8 6h3v3H8zM13 6h3v3h-3zM8 11h3v3H8zM13 11h3v3h-3z", fill: "currentColor", stroke: "none" }],
  ],
  // A hosted service (MCP server): two stacked server units.
  service: [
    ["path", { d: "M3 4h18v7H3zM3 13h18v7H3zM12 7.5h6M12 16.5h6" }],
    ["path", { d: "M6 6.5h2v2H6zM6 15.5h2v2H6z", fill: "currentColor", stroke: "none" }],
  ],
  // A pending network link: two square chain halves joined by a bar.
  link: [["path", { d: "M10 8H4v8h6M14 8h6v8h-6M8 12h8" }]],
  // A coded tool: a six-tooth gear.
  tool: [
    ["path", { d: "M10 5.29V2h4v3.29A7 7 0 0 1 16.81 6.91l2.85-1.64 2 3.46-2.85 1.65a7 7 0 0 1 0 3.24l2.85 1.65-2 3.46-2.85-1.64A7 7 0 0 1 14 18.71V22h-4v-3.29a7 7 0 0 1-2.81-1.62l-2.85 1.64-2-3.46 2.85-1.65a7 7 0 0 1 0-3.24L2.34 8.73l2-3.46 2.85 1.64A7 7 0 0 1 10 5.29z" }],
    ["circle", { cx: "12", cy: "12", r: "3" }],
  ],
  // A warning: a triangle with a bar and a point.
  warning: [
    ["path", { d: "M12 3l10 17.5H2zM12 9.5v4.5" }],
    ["path", { d: "M11 16.25h2v2h-2z", fill: "currentColor", stroke: "none" }],
  ],
  // An agent shown earlier in the tree: an arrow that turns back.
  back: [["path", { d: "M20 4v9H6M10 9l-4 4 4 4" }]],
  // Any other emoji in an icon place: a solid square.
  mark: [["path", { d: "M7 7h10v10H7z", fill: "currentColor", stroke: "none" }]],
};

// The emoji the runtime writes, with or without the emoji variation selector.
const KNOWN = new Map([
  ["\u{1F9ED}", "concierge"], // compass
  ["\u{1F3E2}", "partner"], // office building
  ["\u{1F310}", "service"], // globe with meridians
  ["\u{1F517}", "link"], // link
  ["\u2699", "tool"], // gear
  ["\u26A0", "warning"], // warning sign
  ["\u21A9", "back"], // leftwards arrow with hook
]);

// One emoji: a keycap, a flag, or an emoji-style character with its modifiers and joined parts. A character that
// is text by default (such as the copyright sign) counts only with the emoji variation selector, except the three
// that the runtime writes bare.
const EMOJI_SOURCE =
  "[#*0-9]\\uFE0F?\\u20E3|\\p{Regional_Indicator}{1,2}|" +
  "(?:\\p{Emoji_Presentation}|\\p{Extended_Pictographic}\\uFE0F|[\\u2699\\u26A0\\u21A9])" +
  "(?:\\p{Emoji_Modifier}|\\uFE0F|\\u200D(?:\\p{Emoji_Presentation}|\\p{Extended_Pictographic}\\uFE0F?))*";

/** True when the text holds at least one emoji. */
export function hasEmoji(text) {
  return new RegExp(EMOJI_SOURCE, "u").test(text);
}

/**
 * The text as parts: `{ text }` for words and `{ icon }` for an icon. A known emoji becomes its icon. In an icon
 * place another emoji becomes the mark. Elsewhere a run of other emoji and the spaces around it becomes one space
 * between words, and nothing at the start or end of the text beyond the space that was outside the run.
 * @param {string} text
 * @param {{ iconPlace?: boolean }} [options]
 * @returns {Array<{ text: string } | { icon: keyof typeof ICONS }>}
 */
export function emojiParts(text, { iconPlace = false } = {}) {
  const iconOf = (emoji) => KNOWN.get(emoji.replace(/\uFE0F/g, "")) ?? (iconPlace ? "mark" : null);
  const cleaned = text
    .replace(new RegExp(EMOJI_SOURCE, "gu"), (emoji) => (iconOf(emoji) ? emoji : REMOVED))
    .replace(REMOVED_RUN, (run, offset, whole) => {
      const atStart = offset === 0;
      const atEnd = offset + run.length === whole.length;
      if (atStart && atEnd) return /[ \u00A0]/.test(run) ? " " : "";
      if (atStart) return /^[ \u00A0]/.test(run) ? " " : "";
      if (atEnd) return /[ \u00A0]$/.test(run) ? " " : "";
      return /[ \u00A0]/.test(run) ? " " : "";
    });
  const parts = [];
  let end = 0;
  for (const match of cleaned.matchAll(new RegExp(EMOJI_SOURCE, "gu"))) {
    if (match.index > end) parts.push({ text: cleaned.slice(end, match.index) });
    parts.push({ icon: iconOf(match[0]) });
    end = match.index + match[0].length;
  }
  if (cleaned.length > end) parts.push({ text: cleaned.slice(end) });
  return parts;
}

// A removed emoji's place while emojiParts joins the spaces around it: U+FFFF is a noncharacter, which text
// never holds.
const REMOVED = "\uFFFF";
const REMOVED_RUN = /[ \u00A0]*(?:\uFFFF[ \u00A0]*)+/g;

const SVG_NS = "http://www.w3.org/2000/svg";

/** A decorative SVG element for the icon. Its size follows the font size of the text around it. */
export function iconElement(name, doc = document) {
  const svg = doc.createElementNS(SVG_NS, "svg");
  for (const [key, value] of Object.entries({
    class: "rf-icon",
    "data-icon": name,
    viewBox: "0 0 24 24",
    width: "1em",
    height: "1em",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": "2",
    "stroke-linecap": "square",
    "stroke-linejoin": "miter",
    "aria-hidden": "true",
    focusable: "false",
  })) svg.setAttribute(key, value);
  for (const [tag, attrs] of ICONS[name]) {
    const child = doc.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs)) child.setAttribute(key, value);
    svg.append(child);
  }
  return svg;
}

/**
 * The icon for an agent with the runtime's role text ("your concierge", "partner network" and so on). The runtime
 * gives every brand without its own emoji the compass, also a partner network it has contacted; only the site's own
 * agent keeps the concierge icon.
 * @param {keyof typeof ICONS} icon
 * @param {string | null | undefined} role
 * @returns {keyof typeof ICONS}
 */
export function roleIcon(icon, role) {
  return icon === "concierge" && role != null && !role.startsWith("your concierge") ? "partner" : icon;
}

// The role text next to an icon: an agent in the map (.ns-anode) or the inspector card that opens from it.
function roleNear(element) {
  const agent = element.closest(".ns-anode, .ns-modal-card");
  return agent?.querySelector(".ns-arole, .ns-mrole")?.textContent ?? null;
}

const ICON_PLACES = ".ns-aicon, .ns-ticon, .ns-w-icon";
// The visitor's own words and form fields keep what was typed.
const SKIP = ".ns-msg.user, textarea, input, select, script, style, svg, [contenteditable]";

function replaceText(node) {
  const parent = node.parentElement;
  if (!parent || parent.closest(SKIP) || !hasEmoji(node.data)) return;
  const doc = node.ownerDocument;
  const parts = emojiParts(node.data, { iconPlace: Boolean(parent.closest(ICON_PLACES)) });
  const role = roleNear(parent);
  node.replaceWith(...parts.map((part) => ("icon" in part ? iconElement(roleIcon(part.icon, role), doc) : doc.createTextNode(part.text))));
}

/** Replaces the emoji in every text below `root` (or in `root` itself when it is a text node). */
export function replaceEmoji(root) {
  if (root.nodeType === 3) return replaceText(root);
  if (root.nodeType !== 1 && root.nodeType !== 11) return;
  const doc = root.ownerDocument ?? root;
  const walker = doc.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
  const found = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) if (hasEmoji(node.data)) found.push(node);
  found.forEach(replaceText);
}

/**
 * Keeps `root` free of emoji while the runtime renders into it. A replacement adds no emoji, so the observer's
 * own changes end after one pass. Returns the function that stops the observer.
 */
export function watchEmoji(root) {
  replaceEmoji(root);
  const view = (root.ownerDocument ?? root).defaultView;
  const observer = new view.MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "characterData") replaceEmoji(record.target);
      else record.addedNodes.forEach((node) => node.isConnected && replaceEmoji(node));
    }
  });
  observer.observe(root, { childList: true, subtree: true, characterData: true });
  return () => observer.disconnect();
}
